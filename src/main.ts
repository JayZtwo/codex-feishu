import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, configToStoreSettings, BRIDGE_HOME } from './config.js';
import { JsonFileStore } from './store.js';
import { CodexProvider } from './codex-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { FeishuBridgeService } from './bridge/service.js';
import { FeishuAdapter } from './bridge/feishu.js';
import { RokidAdapter } from './bridge/rokid.js';

const RUNTIME_DIR = path.join(BRIDGE_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[codex-feishu] Starting bridge (run_id: ${runId})`);

  const settings = configToStoreSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = new CodexProvider(pendingPerms);
  const services: FeishuBridgeService[] = [];
  if (config.feishuAppId && config.feishuAppSecret) {
    services.push(new FeishuBridgeService(config, store, pendingPerms, llm, new FeishuAdapter(config, store)));
  }
  if (config.rokidEnabled) {
    services.push(new FeishuBridgeService(config, store, pendingPerms, llm, new RokidAdapter(config)));
  }
  if (services.length === 0) {
    throw new Error('No bridge channels configured. Configure Feishu credentials or set CODEX_FEISHU_ROKID_ENABLED=true.');
  }
  console.log('[codex-feishu] Runtime: codex');
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  const channels: string[] = [];
  for (const service of services) {
    await service.start();
    channels.push(service.getChannelType());
  }
  writeStatus({
    running: true,
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
    channels,
  });
  console.log(`[codex-feishu] Bridge started (PID: ${process.pid}, channels: ${channels.join(', ')})`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[codex-feishu] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await Promise.all(services.map((service) => service.stop()));
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[codex-feishu] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[codex-feishu] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[codex-feishu] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[codex-feishu] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[codex-feishu] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
