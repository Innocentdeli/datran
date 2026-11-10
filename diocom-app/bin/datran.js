#!/usr/bin/env node

/**
 * Datran CLI - Developer Terminal File Transfer & Automation Tool
 * 
 * Usage:
 *   datran send <file> [--expiry 24] [--password secret] [--json]
 *   datran login [--key <token>]
 *   datran whoami
 *   datran list [--json]
 *   datran logout
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode');

const CONFIG_DIR = path.join(os.homedir(), '.datran');
const CONFIG_FILE = path.join(CONFIG_DIR, 'credentials.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {
    server: process.env.DATRAN_SERVER || 'http://localhost:3001',
    apiKey: process.env.DATRAN_API_KEY || null,
  };
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config:', err.message);
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function handleLogin(args) {
  const config = loadConfig();
  let key = null;
  let server = config.server;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) {
      key = args[i + 1];
      i++;
    } else if (args[i] === '--server' && args[i + 1]) {
      server = args[i + 1];
      i++;
    }
  }

  if (!key) {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    key = await new Promise((resolve) => {
      readline.question('Enter your Datran API key (dtr_live_...): ', (answer) => {
        readline.close();
        resolve(answer.trim());
      });
    });
  }

  if (!key || !key.startsWith('dtr_live_')) {
    console.error('❌ Error: Invalid API key format. Datran API keys start with "dtr_live_".');
    process.exit(1);
  }

  console.log('Verifying key with Datran server at ' + server + '...');

  try {
    const res = await fetch(`${server}/api/v1/transfers`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!res.ok) {
      console.error('❌ Authentication failed (HTTP ' + res.status + '). Please check your API key.');
      process.exit(1);
    }

    saveConfig({ server, apiKey: key });
    console.log('\n✅ Successfully authenticated with Datran!');
    console.log('Credentials saved to ' + CONFIG_FILE);
  } catch (err) {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
  }
}

async function handleWhoami() {
  const config = loadConfig();
  if (!config.apiKey) {
    console.log('Not logged in. Run "datran login" to authenticate with your API key.');
    return;
  }

  try {
    const res = await fetch(`${config.server}/api/v1/transfers`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    if (!res.ok) {
      console.log('❌ Saved API key is invalid or expired. Run "datran login" to re-authenticate.');
      return;
    }

    const data = await res.json();
    console.log('\n🔒 Datran CLI Session:');
    console.log('  Server:     ' + config.server);
    console.log('  API Key:    ' + config.apiKey.slice(0, 14) + '...');
    console.log('  Status:     Authenticated');
    console.log('  Active:     ' + (data.transfers?.length || 0) + ' transfers on record\n');
  } catch (err) {
    console.error('Connection error:', err.message);
  }
}

async function handleSend(args) {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('❌ Authentication required. Run "datran login" or pass DATRAN_API_KEY environment variable.');
    process.exit(1);
  }

  let filePath = null;
  let expiryHours = 24;
  let password = null;
  let isJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--expiry' && args[i + 1]) {
      expiryHours = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--password' && args[i + 1]) {
      password = args[i + 1];
      i++;
    } else if (arg === '--json') {
      isJson = true;
    } else if (!arg.startsWith('-') && !filePath) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error('Usage: datran send <filePath> [--expiry <hours>] [--password <pass>] [--json]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error('❌ File not found: ' + resolvedPath);
    process.exit(1);
  }

  const stat = fs.statSync(resolvedPath);
  const fileName = path.basename(resolvedPath);

  if (!isJson) {
    console.log(`\n📤 Uploading ${fileName} (${formatBytes(stat.size)})...`);
  }

  try {
    const fileBuffer = fs.readFileSync(resolvedPath);
    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('expiry_hours', String(expiryHours));
    if (password) formData.append('password', password);

    const res = await fetch(`${config.server}/api/v1/transfers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      if (isJson) {
        console.log(JSON.stringify({ success: false, error: data.error }));
      } else {
        console.error('❌ Upload failed:', data.error);
      }
      process.exit(1);
    }

    const t = data.transfer;
    if (isJson) {
      console.log(JSON.stringify(t, null, 2));
      return;
    }

    console.log('\n✨ Transfer Ready!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  🔗 Link:      ${t.url}`);
    console.log(`  📁 File:      ${t.fileName} (${formatBytes(t.fileSize)})`);
    console.log(`  ⏳ Expires:   ${t.expiresAt ? new Date(t.expiresAt).toLocaleString() : 'Never'}`);
    if (t.hasPassword) console.log('  🔒 Protected: Password required');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Display ASCII QR code in terminal for quick mobile scan
    try {
      const qrAscii = await qrcode.toString(t.url, { type: 'terminal', small: true });
      console.log(qrAscii);
      console.log('Scan QR with phone camera to download instantly.\n');
    } catch {
      // ignore terminal qr errors
    }
  } catch (err) {
    console.error('❌ Error during transfer:', err.message);
    process.exit(1);
  }
}

async function handleList(args) {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('❌ Authentication required. Run "datran login".');
    process.exit(1);
  }

  const isJson = args.includes('--json');

  try {
    const res = await fetch(`${config.server}/api/v1/transfers`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('❌ Failed to list transfers:', data.error);
      process.exit(1);
    }

    if (isJson) {
      console.log(JSON.stringify(data.transfers, null, 2));
      return;
    }

    const transfers = data.transfers || [];
    console.log(`\n📦 Active Transfers (${transfers.length}):\n`);
    if (transfers.length === 0) {
      console.log('  No files shared yet. Use "datran send <file>" to share your first file.');
      return;
    }

    transfers.forEach((tr, i) => {
      const url = `${config.server}/v1/${tr.share_id}`;
      console.log(`  ${i + 1}. ${tr.original_name} (${formatBytes(tr.file_size)})`);
      console.log(`     Link:      ${url}`);
      console.log(`     Downloads: ${tr.downloads} | Uploaded: ${new Date(tr.created_at).toLocaleDateString()}`);
      console.log('');
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

function handleLogout() {
  saveConfig({ server: 'http://localhost:3001', apiKey: null });
  console.log('✅ Logged out. Saved credentials cleared.');
}

function printHelp() {
  console.log(`
Datran CLI - Fast, Private File Sharing from your Terminal

USAGE:
  datran <command> [options]

COMMANDS:
  send <file>        Upload and generate an encrypted transfer link
  login              Authenticate with your Datran API key
  whoami             Display current authenticated session
  list               List your active transfer links
  logout             Remove saved credentials
  help               Show this help message

OPTIONS:
  --expiry <hours>   Set link expiry in hours (default: 24)
  --password <pass>  Protect the transfer with a password
  --json             Output results as raw JSON (ideal for CI/CD)
  --server <url>     Custom Datran instance (default: localhost / datran.app)

EXAMPLES:
  datran send document.pdf
  datran send build.tar.gz --expiry 72 --json
  datran send client-preview.mp4 --password secret123
  datran login --key dtr_live_abcdef123456789
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'send':
      await handleSend(args.slice(1));
      break;
    case 'login':
      await handleLogin(args.slice(1));
      break;
    case 'whoami':
      await handleWhoami();
      break;
    case 'list':
      await handleList(args.slice(1));
      break;
    case 'logout':
      handleLogout();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      if (cmd && !cmd.startsWith('-')) {
        // default shorthand: datran <filename>
        await handleSend(args);
      } else {
        printHelp();
      }
      break;
  }
}

main().catch((err) => {
  console.error('Unexpected CLI error:', err);
  process.exit(1);
});
