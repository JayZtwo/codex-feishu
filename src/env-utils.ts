const ENV_WHITELIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'COLORTERM',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

function shouldAlwaysStrip(key: string): boolean {
  return key === 'CLAUDECODE' || key.startsWith('ANTHROPIC_');
}

export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CODEX_FEISHU_ENV_ISOLATION || 'inherit';
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || shouldAlwaysStrip(key)) {
      continue;
    }

    if (mode === 'inherit') {
      out[key] = value;
      continue;
    }

    if (
      ENV_WHITELIST.has(key) ||
      key.startsWith('CODEX_FEISHU_') ||
      key.startsWith('OPENAI_') ||
      key.startsWith('CODEX_')
    ) {
      out[key] = value;
    }
  }

  return out;
}
