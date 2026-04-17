const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const ipaddr = require('ipaddr.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to fastrecon default plugins
const PLUGINS_DIR = path.join(__dirname, '..', 'semiautorecon', 'default-plugins');
const SEMIAUTORECON_DIR = path.join(__dirname, '..');

const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'operations.log');

function log(message) {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, entry);
  console.log(entry);
}

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please wait and try again.' }
});

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use('/api', rateLimiter);
app.use(express.static(path.join(__dirname, 'public')));

// Load available fastrecon plugins
function loadPlugins() {
  const plugins = [];

  if (!fs.existsSync(PLUGINS_DIR)) {
    console.warn(`Plugins directory not found at ${PLUGINS_DIR}`);
    return plugins;
  }

  const files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.py') && f !== '__init__.py');

  files.forEach((file) => {
    const name = file.replace('.py', '');
    plugins.push({
      name: name,
      slug: name,
      description: `Run fastrecon plugin: ${name}`,
      file: path.join(PLUGINS_DIR, file)
    });
  });

  return plugins;
}

const PLUGINS = loadPlugins();

function validateIp(ip) {
  try {
    const parsed = ipaddr.parse(ip);
    return parsed.kind() === 'ipv4' || parsed.kind() === 'ipv6';
  } catch (error) {
    return false;
  }
}

function executePlugin(pluginFile, ip, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let timeoutHandle;
    let completed = false;

    timeoutHandle = setTimeout(() => {
      if (!completed) {
        completed = true;
        reject(new Error(`Command timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    try {
      // Run the plugin as a Python subprocess with the IP as argument
      const process = spawn('python3', [pluginFile, ip], {
        cwd: SEMIAUTORECON_DIR,
        timeout: timeoutMs
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('error', (error) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutHandle);
          reject(error);
        }
      });

      process.on('close', (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutHandle);
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        }
      });
    } catch (error) {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutHandle);
        reject(error);
      }
    }
  });
}

app.get('/api/commands', (req, res) => {
  res.json(PLUGINS);
});

app.post('/api/execute', async (req, res) => {
  const { ip, pluginName } = req.body;

  if (!ip || !pluginName) {
    return res.status(400).json({ error: 'IP address and plugin name are required.' });
  }

  if (!validateIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address format.' });
  }

  const plugin = PLUGINS.find((p) => p.slug === pluginName);
  if (!plugin) {
    return res.status(400).json({ error: 'Plugin not found.' });
  }

  const startTime = Date.now();
  log(`EXECUTE REQUEST ip=${ip} plugin=${pluginName}`);

  try {
    const result = await executePlugin(plugin.file, ip, 65000);
    const durationMs = Date.now() - startTime;
    log(`EXECUTED ip=${ip} plugin=${pluginName} duration=${durationMs}ms exit=${result.code}`);
    res.json({
      pluginName,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs
    });
  } catch (error) {
    log(`ERROR ip=${ip} plugin=${pluginName} message=${error.message}`);
    res.status(500).json({ error: error.message || 'Plugin execution failed.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', pluginCount: PLUGINS.length });
});

app.use((err, req, res, next) => {
  log(`SERVER ERROR ${err.message}`);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  log(`Fastrecon web executor listening on http://localhost:${PORT}`);
  log(`Loaded ${PLUGINS.length} plugins from ${PLUGINS_DIR}`);
});
