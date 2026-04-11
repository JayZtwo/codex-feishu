#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const BRIDGE_HOME = process.env.CODEX_FEISHU_HOME || path.join(os.homedir(), '.codex-feishu');
const CONFIG_FILE = path.join(BRIDGE_HOME, 'config.env');
const PID_FILE = path.join(BRIDGE_HOME, 'runtime', 'bridge.pid');
const LOG_FILE = path.join(BRIDGE_HOME, 'logs', 'bridge.log');
const DAEMON_FILE = path.join(SKILL_DIR, 'dist', 'daemon.mjs');
const IS_WINDOWS = process.platform === 'win32';

const resultCounts = {
  ok: 0,
  warn: 0,
  fail: 0,
};

function printResult(level, label) {
  if (level === 'OK') resultCounts.ok += 1;
  if (level === 'WARN') resultCounts.warn += 1;
  if (level === 'FAIL') resultCounts.fail += 1;
  console.log(`[${level}] ${label}`);
}

function ok(label) {
  printResult('OK', label);
}

function warn(label) {
  printResult('WARN', label);
}

function fail(label) {
  printResult('FAIL', label);
}

function parseEnvFile(content) {
  const entries = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function readConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return new Map();
  }
  return parseEnvFile(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findAllCodexInPath() {
  try {
    const output = IS_WINDOWS
      ? execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 3_000 })
      : execFileSync('which', ['-a', 'codex'], { encoding: 'utf8', timeout: 3_000 });
    return output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveCodexCliPath() {
  const fromEnv = process.env.CODEX_FEISHU_CODEX_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) {
    return fromEnv;
  }

  const wellKnown = IS_WINDOWS
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'codex.exe') : '',
      ].filter(Boolean)
    : [
        '/Applications/Codex.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        process.env.HOME ? path.join(process.env.HOME, '.npm-global', 'bin', 'codex') : '',
        process.env.HOME ? path.join(process.env.HOME, '.local', 'bin', 'codex') : '',
      ].filter(Boolean);

  const seen = new Set();
  for (const candidate of [...findAllCodexInPath(), ...wellKnown]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function trimDetail(detail) {
  const text = String(detail || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function execCapture(file, args, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: SKILL_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-32_768);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_768);
    });
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr: error.message, exitCode: null, timedOut: false });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr, exitCode: code, timedOut: false });
    });
  });
}

function stringifyJsonRpcError(error) {
  if (!error || typeof error !== 'object') {
    return 'Unknown JSON-RPC error';
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    if (error.data === undefined) {
      return error.message;
    }
    try {
      return `${error.message}: ${JSON.stringify(error.data)}`;
    } catch {
      return error.message;
    }
  }
  if (error.data !== undefined) {
    try {
      return JSON.stringify(error.data);
    } catch {
      return 'Unknown JSON-RPC error';
    }
  }
  return 'Unknown JSON-RPC error';
}

async function probeCodexAppServer(codexPath) {
  return new Promise((resolve) => {
    const child = spawn(
      codexPath,
      ['app-server', '--listen', 'stdio://', '-c', 'skip_git_repo_check=true'],
      {
        cwd: SKILL_DIR,
        env: {
          ...process.env,
          TERM: process.env.TERM || 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let lineBuffer = '';
    let stderrBuffer = '';
    let stdoutBuffer = '';
    let phase = 'initialize';
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore shutdown races
      }
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        detail: trimDetail(stderrBuffer || stdoutBuffer || 'Timed out waiting for Codex app-server handshake'),
      });
    }, 5_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer = `${stdoutBuffer}${chunk}`.slice(-32_768);
      lineBuffer += chunk;

      while (true) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 0) {
          if (message.error) {
            finish({ ok: false, detail: trimDetail(stringifyJsonRpcError(message.error)) });
            return;
          }
          phase = 'config/read';
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 1, method: 'config/read', params: {} })}\n`);
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish({ ok: false, detail: trimDetail(stringifyJsonRpcError(message.error)) });
            return;
          }
          finish({ ok: true, detail: 'initialize + config/read handshake succeeded' });
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-32_768);
    });
    child.on('error', (error) => {
      finish({ ok: false, detail: trimDetail(error.message) });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      const detail = trimDetail(
        stderrBuffer ||
        stdoutBuffer ||
        `Codex app-server exited during ${phase} with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`,
      );
      finish({ ok: false, detail });
    });

    child.stdin.write(`${JSON.stringify({
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex-feishu-doctor',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    })}\n`);
  });
}

async function detectCodexAuth(codexPath) {
  if (process.env.CODEX_FEISHU_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
    return { ok: true, label: 'Codex auth available (env)' };
  }

  if (!codexPath) {
    return { ok: false, label: 'Codex auth available', detail: 'codex executable not found' };
  }

  for (const args of [['login', 'status'], ['auth', 'status']]) {
    const result = await execCapture(codexPath, args);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/logged[ -]?in|authenticated/i.test(output)) {
      return { ok: true, label: 'Codex auth available (CLI login)' };
    }
  }

  return {
    ok: false,
    label: "Codex auth available (set OPENAI_API_KEY or run 'codex auth login')",
  };
}

async function validateFeishuCredentials(config) {
  const appId = config.get('CODEX_FEISHU_APP_ID');
  const appSecret = config.get('CODEX_FEISHU_APP_SECRET');
  const domain = config.get('CODEX_FEISHU_DOMAIN') || 'https://open.feishu.cn';

  if (!appId || !appSecret) {
    return { ok: false, label: 'Feishu app credentials configured' };
  }

  try {
    const response = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const payload = await response.json().catch(() => ({}));
    if (payload && payload.code === 0) {
      return { ok: true, label: 'Feishu app credentials are valid' };
    }
    return {
      ok: false,
      label: 'Feishu app credentials are valid (token request failed)',
      detail: trimDetail(payload?.msg || `${response.status} ${response.statusText}`),
    };
  } catch (error) {
    return {
      ok: false,
      label: 'Feishu app credentials are valid (token request failed)',
      detail: trimDetail(error instanceof Error ? error.message : String(error)),
    };
  }
}

function readTail(filePath, lineCount) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).slice(-lineCount).join('\n');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const config = readConfigFile();
  const logDir = path.join(BRIDGE_HOME, 'logs');
  const codexPath = resolveCodexCliPath();

  console.log('Runtime: codex');
  console.log('Channel: feishu');
  console.log(`Platform: ${process.platform}`);
  console.log('');

  const nodeMajor = Number(process.versions.node.split('.')[0] || '0');
  if (nodeMajor >= 20) {
    ok(`Node.js >= 20 (found v${process.versions.node})`);
  } else {
    fail(`Node.js >= 20 (found v${process.versions.node})`);
  }

  if (codexPath) {
    const versionResult = await execCapture(codexPath, ['--version']);
    const versionText = trimDetail(versionResult.stdout || versionResult.stderr || 'unknown');
    ok(`Codex CLI available (${versionText || 'unknown'})`);
  } else {
    fail('Codex CLI available');
  }

  const authStatus = await detectCodexAuth(codexPath);
  (authStatus.ok ? ok : fail)(authStatus.label);

  if (fs.existsSync(path.join(SKILL_DIR, 'node_modules', '@larksuiteoapi', 'node-sdk')) &&
      fs.existsSync(path.join(SKILL_DIR, 'node_modules', 'markdown-it'))) {
    ok('Bridge dependencies installed');
  } else {
    fail(`Bridge dependencies installed (run 'npm install' in ${SKILL_DIR})`);
  }

  if (fs.existsSync(DAEMON_FILE)) {
    const daemonStat = fs.statSync(DAEMON_FILE);
    const staleSource = fs.readdirSync(path.join(SKILL_DIR, 'src'), { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.ts'))
      .map((entry) => path.join(SKILL_DIR, 'src', entry))
      .find((entry) => fs.statSync(entry).mtimeMs > daemonStat.mtimeMs);
    if (staleSource) {
      fail("dist/daemon.mjs is stale (run 'npm run build')");
    } else {
      ok('dist/daemon.mjs is up to date');
    }
  } else {
    fail("dist/daemon.mjs exists (run 'npm run build')");
  }

  if (fs.existsSync(CONFIG_FILE)) {
    ok('config.env exists');
  } else {
    fail(`config.env exists (${CONFIG_FILE} not found)`);
  }

  if (fs.existsSync(CONFIG_FILE)) {
    if (IS_WINDOWS) {
      warn('config.env ACL check skipped on Windows');
    } else {
      const mode = fs.statSync(CONFIG_FILE).mode & 0o777;
      if (mode === 0o600) {
        ok('config.env permissions are 600');
      } else {
        fail(`config.env permissions are 600 (currently ${mode.toString(8)})`);
      }
    }
  }

  if (codexPath) {
    const appServerProbe = await probeCodexAppServer(codexPath);
    if (appServerProbe.ok) {
      ok(`Codex app-server available (${appServerProbe.detail})`);
    } else {
      fail(`Codex app-server available (update Codex to a build that supports 'codex app-server'${appServerProbe.detail ? `; ${appServerProbe.detail}` : ''})`);
    }
  } else {
    fail("Codex app-server available (missing 'codex' executable)");
  }

  const feishuStatus = await validateFeishuCredentials(config);
  (feishuStatus.ok ? ok : fail)(`${feishuStatus.label}${feishuStatus.detail ? `: ${feishuStatus.detail}` : ''}`);

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.accessSync(logDir, fs.constants.W_OK);
    ok('Log directory is writable');
  } catch {
    fail(`Log directory is writable (${logDir})`);
  }

  if (fs.existsSync(PID_FILE)) {
    const rawPid = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number(rawPid);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      ok(`PID file consistent (process ${pid} is running)`);
    } else {
      fail(`PID file consistent (stale PID ${rawPid || 'unknown'}, process not running)`);
    }
  } else {
    ok('PID file consistency (no PID file, OK)');
  }

  if (fs.existsSync(LOG_FILE)) {
    const tail = readTail(LOG_FILE, 50);
    const errorCount = (tail.match(/ERROR|Fatal|uncaughtException|unhandledRejection/gi) || []).length;
    if (errorCount === 0) {
      ok('No recent errors in log (last 50 lines)');
    } else {
      fail(`No recent errors in log (found ${errorCount} error lines)`);
    }
  } else {
    ok('Log file exists (not yet created)');
  }

  console.log('');
  console.log(`Results: ${resultCounts.ok} passed, ${resultCounts.warn} warnings, ${resultCounts.fail} failed`);

  if (resultCounts.fail > 0 || resultCounts.warn > 0) {
    console.log('');
    console.log('Common fixes:');
    console.log(`  Missing dependencies  -> cd ${SKILL_DIR} && npm install`);
    console.log(`  Stale bundle          -> cd ${SKILL_DIR} && npm run build`);
    console.log(`  Missing config        -> copy config.env.example to ${CONFIG_FILE}`);
    console.log("  Bad login             -> run 'codex auth login'");
    console.log("  Missing app-server    -> update Codex, or point CODEX_FEISHU_CODEX_EXECUTABLE at a compatible codex binary");
    if (IS_WINDOWS) {
      console.log(`  Windows daemon        -> powershell -File "${path.join(SKILL_DIR, 'scripts', 'daemon.ps1')}" start`);
    } else {
      console.log(`  POSIX daemon          -> bash "${path.join(SKILL_DIR, 'scripts', 'daemon.sh')}" start`);
    }
  }

  process.exit(resultCounts.fail === 0 ? 0 : 1);
}

await main();
