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
