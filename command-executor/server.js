const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const ipaddr = require('ipaddr.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SSH_USER = process.env.SSH_USER || 'ubuntu';
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;

function getSshPrivateKey() {
  if (process.env.SSH_PRIVATE_KEY) {
    return process.env.SSH_PRIVATE_KEY;
  }

  if (SSH_PRIVATE_KEY_PATH) {
    try {
      return fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8');
    } catch (error) {
      console.error('ERROR: Failed to read SSH_PRIVATE_KEY_PATH:', error.message);
      return null;
    }
  }

  return null;
}

const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'operations.log');

function log(message) {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logFile, entry);
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

const SSH_COMMANDS = [
  {
    syntax: 'uname -a',
    command: 'uname -a',
    description: 'Show operating system and kernel information.'
  },
  {
    syntax: 'uptime',
    command: 'uptime',
    description: 'Show system uptime and load averages.'
  },
  {
    syntax: 'df -h',
    command: 'df -h',
    description: 'Show disk usage for mounted filesystems in human-readable format.'
  },
  {
    syntax: 'whoami',
    command: 'whoami',
    description: 'Display the remote username used for the SSH session.'
  },
  {
    syntax: 'cat /etc/os-release',
    command: 'cat /etc/os-release',
    description: 'Show operating system release information.'
  }
];

function validateIp(ip) {
  try {
    const parsed = ipaddr.parse(ip);
    return parsed.kind() === 'ipv4' || parsed.kind() === 'ipv6';
  } catch (error) {
    return false;
  }
}

function sanitizeCommand(command) {
  return SSH_COMMANDS.some((entry) => entry.command === command);
}

function executeSshCommand(ip, command, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const privateKey = getSshPrivateKey();
    if (!privateKey) {
      return reject(new Error('SSH private key is not configured.'));
    }

    const conn = new Client();
    let timeoutHandle;
    let completed = false;

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      conn.end();
      completed = true;
    }

    timeoutHandle = setTimeout(() => {
      if (!completed) {
        cleanup();
        reject(new Error('Command timed out after ' + timeoutMs + 'ms.'));
      }
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            cleanup();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code, signal) => {
            cleanup();
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, signal });
          });

          stream.on('data', (data) => {
            stdout += data.toString();
          });

          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      })
      .on('error', (error) => {
        if (!completed) {
          cleanup();
          reject(error);
        }
      })
      .connect({
        host: ip,
        port: 22,
        username: SSH_USER,
        privateKey: privateKey,
        readyTimeout: 20000,
        hostVerifier: () => true
      });
  });
}

app.get('/api/commands', (req, res) => {
  res.json(SSH_COMMANDS);
});

app.post('/api/execute', async (req, res) => {
  const { ip, command } = req.body;

  if (!ip || !command) {
    return res.status(400).json({ error: 'IP address and command are required.' });
  }

  if (!validateIp(ip)) {
    return res.status(400).json({ error: 'Invalid IP address format.' });
  }

  if (!sanitizeCommand(command)) {
    return res.status(400).json({ error: 'Command is not allowed.' });
  }

  const privateKey = getSshPrivateKey();
  if (!privateKey) {
    return res.status(500).json({ error: 'SSH private key is not configured. Set SSH_PRIVATE_KEY or SSH_PRIVATE_KEY_PATH.' });
  }

  const startTime = Date.now();
  log(`EXECUTE REQUEST ip=${ip} command=${command}`);

  try {
    const result = await executeSshCommand(ip, command, 25000);
    const durationMs = Date.now() - startTime;
    log(`EXECUTED ip=${ip} command=${command} duration=${durationMs}ms exit=${result.code}`);
    res.json({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      signal: result.signal,
      durationMs
    });
  } catch (error) {
    log(`ERROR ip=${ip} command=${command} message=${error.message}`);
    res.status(500).json({ error: error.message || 'SSH execution failed.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use((err, req, res, next) => {
  log(`SERVER ERROR ${err.message}`);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Command executor server listening on http://localhost:${PORT}`);
});
