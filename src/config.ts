import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  rokidEnabled: boolean;
  rokidHost: string;
  rokidPort: number;
  rokidPath: string;
  rokidSecret?: string;
  rokidAllowedUsers?: string[];
  rokidAutoAllowPermissions: boolean;
}

export const BRIDGE_HOME = process.env.CODEX_FEISHU_HOME || path.join(os.homedir(), '.codex-feishu');
export const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
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

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    env = parseEnvFile(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    // Ignore missing config; callers handle first-run setup.
  }

  return {
    defaultWorkDir: env.get('CODEX_FEISHU_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: env.get('CODEX_FEISHU_DEFAULT_MODEL') || undefined,
    defaultMode: env.get('CODEX_FEISHU_DEFAULT_MODE') || 'code',
    feishuAppId: env.get('CODEX_FEISHU_APP_ID') || undefined,
    feishuAppSecret: env.get('CODEX_FEISHU_APP_SECRET') || undefined,
    feishuDomain: env.get('CODEX_FEISHU_DOMAIN') || undefined,
    feishuAllowedUsers: splitCsv(env.get('CODEX_FEISHU_ALLOWED_USERS')),
    rokidEnabled: parseBool(env.get('CODEX_FEISHU_ROKID_ENABLED')),
    rokidHost: env.get('CODEX_FEISHU_ROKID_HOST') || '127.0.0.1',
    rokidPort: parsePort(env.get('CODEX_FEISHU_ROKID_PORT'), 8787),
    rokidPath: env.get('CODEX_FEISHU_ROKID_PATH') || '/rokid/agent',
    rokidSecret: env.get('CODEX_FEISHU_ROKID_SECRET') || undefined,
    rokidAllowedUsers: splitCsv(env.get('CODEX_FEISHU_ROKID_ALLOWED_USERS')),
    rokidAutoAllowPermissions: parseBool(env.get('CODEX_FEISHU_ROKID_AUTO_ALLOW_PERMISSIONS'), true),
  };
}

export function configToStoreSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set('default_workdir', config.defaultWorkDir);
  settings.set('default_mode', config.defaultMode);

  if (config.defaultModel) {
    settings.set('default_model', config.defaultModel);
  }

  return settings;
}
