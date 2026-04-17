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

// Paths to fastrecon components
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

function extractCommandTemplate(content) {
  const executeMatch = content.match(/target\.execute\(([^\)]*)\)/s);
  if (!executeMatch) {
    return null;
  }

  let args = executeMatch[1].trim();
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let firstArg = '';

  for (let i = 0; i < args.length; i++) {
    const char = args[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    if (!inSingle && !inDouble) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === ',' && depth === 0) {
        break;
      }
    }

    firstArg += char;
  }

  const segments = [];
  let current = '';
  inSingle = false;
  inDouble = false;

  for (let i = 0; i < firstArg.length; i++) {
    const char = firstArg[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    if (!inSingle && !inDouble && char === '+') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments
    .map((segment) => {
      const trimmed = segment.trim();
      if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1);
      }
      return '${' + trimmed + '}';
    })
    .join('');
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

// Load plugin metadata with service matching patterns
function loadPlugins() {
  const plugins = {
    portScan: [],
    serviceScan: {}
  };

  if (!fs.existsSync(PLUGINS_DIR)) {
    console.warn(`Plugins directory not found at ${PLUGINS_DIR}`);
    return plugins;
  }

  const files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith('.py') && f !== '__init__.py');

  files.forEach((file) => {
    const name = file.replace('.py', '');
    const pluginFile = path.join(PLUGINS_DIR, file);
    const content = fs.readFileSync(pluginFile, 'utf8');

    // Determine plugin type
    if (content.includes('class') && content.includes('PortScan')) {
      plugins.portScan.push({
        name: name,
        slug: name,
        type: 'portscan',
        file: pluginFile,
        commandTemplate: extractCommandTemplate(content)
      });
    } else if (content.includes('class') && content.includes('ServiceScan')) {
      const patterns = extractPatterns(content);

      plugins.serviceScan[name] = {
        name: name,
        slug: name,
        type: 'servicescan',
        file: pluginFile,
        serviceNames: patterns.serviceNames,
        ports: patterns.ports,
        commandTemplate: extractCommandTemplate(content)
      };
    }
  });

  return plugins;
}

function extractPatterns(content) {
  const serviceNames = new Set();
  const ports = new Set();

  // Extract service names from match_service_name calls
  const serviceMatches = content.matchAll(/match_service_name\(\s*(\[?[^\]]*\]?)/gi);
  for (const match of serviceMatches) {
    const patterns = match[1].match(/'([^']+)'/g) || match[1].match(/"([^"]+)"/g) || [];
    patterns.forEach((p) => {
      const cleaned = p.replace(/['"]/g, '');
      if (cleaned) serviceNames.add(cleaned);
    });
  }

  // Extract ports from match_port calls
  const portMatches = content.matchAll(/match_port\s*\(\s*['"]?(tcp|udp)['"]?,\s*(\[?[\d,\s]+\]?)/gi);
  for (const match of portMatches) {
    const portStr = match[2].replace(/[\[\]]/g, '');
    const portNums = portStr.match(/\d+/g) || [];
    portNums.forEach((p) => ports.add(parseInt(p)));
  }

  return {
    serviceNames: Array.from(serviceNames),
    ports: Array.from(ports)
  };
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

// Parse nmap output to extract services
function parseNmapOutput(output) {
  const services = [];
  const lines = output.split('\n');

  lines.forEach((line) => {
    // Match lines like: "22/tcp   open  ssh"
    const match = line.match(/^(\d+)\/(tcp|udp)\s+open\s+(.+?)(\s|$)/);
    if (match) {
      const port = parseInt(match[1]);
      const protocol = match[2].toLowerCase();
      let serviceName = match[3].trim();

      // Handle ssl/tls prefix
      if (serviceName.startsWith('ssl/') || serviceName.startsWith('tls/')) {
        serviceName = serviceName.substring(4);
      }

      services.push({
        port,
        protocol,
        name: serviceName
      });
    }
  });

  return services;
}

// Filter service scan plugins based on discovered services
function filterServiceScanPlugins(discoveredServices) {
  const applicable = [];

  Object.values(PLUGINS.serviceScan).forEach((plugin) => {
    let matches = false;

    discoveredServices.forEach((service) => {
      // Check service name patterns
      if (plugin.serviceNames.length > 0) {
        plugin.serviceNames.forEach((pattern) => {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(service.name)) {
              matches = true;
            }
          } catch (e) {
            // Invalid regex, skip
          }
        });
      }

      // Check port patterns
      if (!matches && plugin.ports.length > 0) {
        if (plugin.ports.includes(service.port)) {
          matches = true;
        }
      }
    });

    if (matches) {
      applicable.push(plugin);
    }
  });

  return applicable;
}

// API: Get initial phase (port scan plugins)
app.get('/api/phase1/commands', (req, res) => {
  res.json(PLUGINS.portScan);
});

// API: Execute port scan and return discovered services
app.post('/api/phase1/execute', async (req, res) => {
  const { ip, pluginName } = req.body;

  if (!ip || !pluginName) {
    return res.status(400).json({ error: 'IP address and plugin name are required.' });
  }

  if (!validateIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address format.' });
  }

  const plugin = PLUGINS.portScan.find((p) => p.slug === pluginName);
  if (!plugin) {
    return res.status(400).json({ error: 'Plugin not found.' });
  }

  const startTime = Date.now();
  log(`PORT SCAN ip=${ip} plugin=${pluginName}`);

  try {
    const result = await executePlugin(plugin.file, ip, 120000);
    const durationMs = Date.now() - startTime;
    const services = parseNmapOutput(result.stdout);

    log(`PORT SCAN COMPLETE ip=${ip} plugin=${pluginName} services=${services.length} duration=${durationMs}ms`);

    res.json({
      pluginName,
      services,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs
    });
  } catch (error) {
    log(`PORT SCAN ERROR ip=${ip} plugin=${pluginName} message=${error.message}`);
    res.status(500).json({ error: error.message || 'Port scan failed.' });
  }
});

// API: Get phase 2 (service scan plugins) based on discovered services
app.post('/api/phase2/commands', (req, res) => {
  const { services } = req.body;

  if (!Array.isArray(services)) {
    return res.status(400).json({ error: 'Services array is required.' });
  }

  const applicablePlugins = filterServiceScanPlugins(services);
  res.json(applicablePlugins);
});

// API: Execute service scan plugin
app.post('/api/phase2/execute', async (req, res) => {
  const { ip, pluginName } = req.body;

  if (!ip || !pluginName) {
    return res.status(400).json({ error: 'IP address and plugin name are required.' });
  }

  if (!validateIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address format.' });
  }

  const plugin = PLUGINS.serviceScan[pluginName];
  if (!plugin) {
    return res.status(400).json({ error: 'Plugin not found.' });
  }

  const startTime = Date.now();
  log(`SERVICE SCAN ip=${ip} plugin=${pluginName}`);

  try {
    const result = await executePlugin(plugin.file, ip, 90000);
    const durationMs = Date.now() - startTime;
    log(`SERVICE SCAN COMPLETE ip=${ip} plugin=${pluginName} duration=${durationMs}ms`);

    res.json({
      pluginName,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      durationMs
    });
  } catch (error) {
    log(`SERVICE SCAN ERROR ip=${ip} plugin=${pluginName} message=${error.message}`);
    res.status(500).json({ error: error.message || 'Service scan failed.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    portScanPlugins: PLUGINS.portScan.length,
    serviceScanPlugins: Object.keys(PLUGINS.serviceScan).length
  });
});

app.use((err, req, res, next) => {
  log(`SERVER ERROR ${err.message}`);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  log(`Fastrecon web executor listening on http://localhost:${PORT}`);
  log(`Loaded ${PLUGINS.portScan.length} port scan plugins and ${Object.keys(PLUGINS.serviceScan).length} service scan plugins`);
});
