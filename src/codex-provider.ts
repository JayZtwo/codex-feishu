import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { LLMProvider, StreamChatParams, TokenUsage } from './bridge/contracts.js';
import { buildSubprocessEnv } from './env-utils.js';
import type { PendingPermissions } from './permission-gateway.js';
import { CodexAppServerClient, type AppServerJsonRpcMessage } from './codex-app-server.js';
import {
  cleanTerminalOutput,
  CodexCliStdoutParser,
  parseCodexRolloutRecord,
} from './codex-cli-stream.js';
import { sseEvent } from './sse-utils.js';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const ROLLOUT_SCAN_INTERVAL_MS = 250;
const ROLLOUT_SETTLE_INTERVAL_MS = 200;
const ROLLOUT_SETTLE_PASSES = 6;
const RESUME_ROLLOUT_TAIL_BYTES = 1_024 * 1_024;
const STDOUT_BATCH_IDLE_MS = 120;
const STDOUT_BATCH_MAX_CHARS = 12;
const MAX_CAPTURED_STDIO_CHARS = 200_000;
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_IMPORTED_HISTORY_MESSAGES = 12;
const MAX_IMPORTED_HISTORY_MESSAGE_CHARS = 2_000;
const MAX_IMPORTED_HISTORY_TOTAL_CHARS = 12_000;

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findAllCodexInPath(): string[] {
  try {
    const command = process.platform === 'win32' ? 'where codex' : 'which -a codex';
    return execSync(command, { encoding: 'utf8', timeout: 3_000 })
      .trim()
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveCodexCliPath(): string | undefined {
  const fromEnv = process.env.CODEX_FEISHU_CODEX_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) {
    return fromEnv;
  }

  const wellKnown = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\OpenAI\\Codex\\codex.exe` : '',
      ].filter(Boolean)
    : [
        '/Applications/Codex.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        `${process.env.HOME}/.npm-global/bin/codex`,
        `${process.env.HOME}/.local/bin/codex`,
      ];

  const seen = new Set<string>();
  for (const candidate of [...findAllCodexInPath(), ...wellKnown]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function shouldPassModelToCodex(): boolean {
  return process.env.CODEX_FEISHU_PASS_MODEL === 'true';
}

function looksLikeNonCodexModel(model?: string): boolean {
  return !!model && /^claude[-_]/i.test(model);
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

const CODEX_WORKSPACE_ERROR_PATTERNS = [
  /deactivated_workspace/i,
  /402\b.*payment required/i,
];

const CODEX_QUOTA_ERROR_PATTERNS = [
  /insufficient_quota/i,
  /billing_hard_limit_reached/i,
  /quota.*(?:exceeded|exhausted|used up|reached)/i,
  /credit balance .*too low/i,
];

const CODEX_RATE_LIMIT_ERROR_PATTERNS = [
  /429\b/,
  /rate limit/i,
  /too many requests/i,
];

const CODEX_CAPACITY_ERROR_PATTERNS = [
  /server_overloaded/i,
  /selected model is at capacity/i,
  /model is at capacity/i,
  /please try a different model/i,
];

const CODEX_AUTH_ERROR_PATTERNS = [
  /not logged in/i,
  /codex auth login/i,
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
];

const CODEX_NOISE_PATTERNS = [
  /^Reading prompt from stdin/i,
];

export type CodexUserErrorKind = 'workspace' | 'quota' | 'rate_limit' | 'capacity' | 'auth' | false;

export function classifyCodexUserError(text: string): CodexUserErrorKind {
  if (!text) return false;
  if (CODEX_WORKSPACE_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'workspace';
  if (CODEX_QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'quota';
  if (CODEX_RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'rate_limit';
  if (CODEX_CAPACITY_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'capacity';
  if (CODEX_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return 'auth';
  return false;
}

function uniqueNonNoiseLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  return lines;
}

function summarizeCodexErrorDetail(text: string): string {
  const lines = uniqueNonNoiseLines(text);
  if (lines.length === 0) return '';

  const prioritized = [
    /deactivated_workspace/i,
    /insufficient_quota/i,
    /billing_hard_limit_reached/i,
    /quota/i,
    /429\b/,
    /rate limit/i,
    /server_overloaded/i,
    /selected model is at capacity/i,
    /model is at capacity/i,
    /not logged in/i,
    /unauthorized/i,
    /invalid.*api.?key/i,
    /authentication.*failed/i,
  ];

  for (const pattern of prioritized) {
    const matched = lines.find((line) => pattern.test(line));
    if (matched) {
      return matched.length > 220 ? `${matched.slice(0, 220)}...` : matched;
    }
  }

  const fallback = lines[0];
  return fallback.length > 220 ? `${fallback.slice(0, 220)}...` : fallback;
}

export function humanizeCodexError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  const kind = classifyCodexUserError(trimmed);
  const detail = summarizeCodexErrorDetail(trimmed);

  switch (kind) {
    case 'workspace':
      return [
        'Codex 当前不可用：当前 workspace 已停用，或该工作区额度不可用。',
        '处理方式：检查 ChatGPT / Codex 工作区状态，恢复订阅或切换到可用 workspace 后重试。',
        ...(detail ? [`详情：${detail}`] : []),
      ].join('\n');
    case 'quota':
      return [
        'Codex 当前不可用：额度已用完，或计费额度被限制。',
        '处理方式：检查 OpenAI / Codex 的 billing 与 quota，恢复后重试。',
        ...(detail ? [`详情：${detail}`] : []),
      ].join('\n');
    case 'rate_limit':
      return [
        'Codex 当前请求过多，暂时被限流。',
        '处理方式：稍等片刻后重试，或降低并发请求。',
        ...(detail ? [`详情：${detail}`] : []),
      ].join('\n');
    case 'capacity':
      return [
        'Codex 当前不可用：所选模型当前容量已满。',
        '处理方式：稍后重试，或切换到其他可用模型后再试。',
        ...(detail ? [`详情：${detail}`] : []),
      ].join('\n');
    case 'auth':
      return [
        'Codex 当前不可用：登录状态或 API 凭证失效。',
        '处理方式：执行 `codex auth login`，或检查 OPENAI_API_KEY / CODEX_API_KEY。',
        ...(detail ? [`详情：${detail}`] : []),
      ].join('\n');
    default:
      return uniqueNonNoiseLines(trimmed).join('\n') || trimmed;
  }
}

function toCliExecutionArgs(permissionMode?: string): string[] {
  switch (permissionMode) {
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'default':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
    case 'acceptEdits':
    default:
      return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'];
  }
}

interface CodexCliInvocationInput {
  codexPath: string;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  permissionMode?: string;
  imagePaths: string[];
}

export function buildCodexCliArgs(input: CodexCliInvocationInput): string[] {
  const optionArgs = [
    '-c', 'skip_git_repo_check=true',
    '--no-alt-screen',
    ...toCliExecutionArgs(input.permissionMode),
  ];

  if (input.model && shouldPassModelToCodex()) {
    optionArgs.push('-m', input.model);
  }

  for (const imagePath of input.imagePaths) {
    optionArgs.push('-i', imagePath);
  }

  if (input.resumeSessionId) {
    return ['resume', ...optionArgs, input.resumeSessionId, input.prompt];
  }

  return [...optionArgs, input.prompt];
}

const PYTHON_PTY_PROXY = [
  'import os',
  'import pty',
  'import select',
  'import subprocess',
  'import sys',
  '',
  'cmd = sys.argv[1:]',
  'master, slave = pty.openpty()',
  'proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)',
  'os.close(slave)',
  '',
  'try:',
  '    while True:',
  '        reads = [master]',
  '        if not sys.stdin.closed:',
  '            reads.append(sys.stdin.fileno())',
  '        ready, _, _ = select.select(reads, [], [], 0.1)',
  '        if master in ready:',
  '            try:',
  '                data = os.read(master, 65536)',
  '            except OSError:',
  '                data = b""',
  '            if data:',
  '                os.write(sys.stdout.fileno(), data)',
  '                sys.stdout.flush()',
  '            elif proc.poll() is not None:',
  '                break',
  '        if not sys.stdin.closed and sys.stdin.fileno() in ready:',
  '            data = os.read(sys.stdin.fileno(), 65536)',
  '            if data:',
  '                os.write(master, data)',
  '        if proc.poll() is not None and not ready:',
  '            break',
  'finally:',
  '    try:',
  '        os.close(master)',
  '    except OSError:',
  '        pass',
  '',
  'sys.exit(proc.wait())',
].join('\n');

function buildPtyInvocation(codexPath: string, codexArgs: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: codexPath,
      args: codexArgs,
    };
  }

  return {
    command: 'python3',
    args: ['-c', PYTHON_PTY_PROXY, codexPath, ...codexArgs],
  };
}

function createCodexEnv(): Record<string, string> {
  const env = buildSubprocessEnv();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';

  if (process.env.CODEX_FEISHU_API_KEY) {
    env.OPENAI_API_KEY ||= process.env.CODEX_FEISHU_API_KEY;
    env.CODEX_API_KEY ||= process.env.CODEX_FEISHU_API_KEY;
  }

  if (process.env.CODEX_FEISHU_BASE_URL) {
    env.OPENAI_BASE_URL ||= process.env.CODEX_FEISHU_BASE_URL;
  }

  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPrefix(filePath: string, bytes = 32 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const ROLLOUT_HEAD_SCAN_BYTES = 1_024 * 1_024;

export function rolloutHeadContainsPrompt(prefix: string, prompt: string): boolean {
  const lines = prefix.split('\n').filter(Boolean);
  for (const line of lines) {
    if (isCurrentTurnPromptRecord(line, prompt)) {
      return true;
    }
  }
  return false;
}

function buildCandidateSessionDirs(startTimeMs: number): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;

  for (const offset of [0, -oneDayMs]) {
    const date = new Date(startTimeMs + offset);
    const dir = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    );
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  return dirs;
}

interface RolloutMatchCriteria {
  startTimeMs: number;
  prompt: string;
  workingDirectory: string;
  resumeSessionId?: string;
}

interface RolloutMatch {
  filePath: string;
  sessionId: string;
}

function extractUserMessageText(record: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record) as Record<string, unknown>;
  } catch {
    return null;
  }

  const payload = (parsed.payload ?? {}) as Record<string, unknown>;
  if (
    parsed.type === 'event_msg' &&
    payload.type === 'user_message' &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  if (
    parsed.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'user' &&
    Array.isArray(payload.content)
  ) {
    const text = payload.content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        const block = item as Record<string, unknown>;
        return block.type === 'input_text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
    return text || null;
  }

  return null;
}

function parseRecordTimestampMs(record: string): number | null {
  try {
    const parsed = JSON.parse(record) as Record<string, unknown>;
    const raw = parsed.timestamp;
    if (typeof raw !== 'string') {
      return null;
    }
    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function truncatePromptContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[history truncated ${omitted} chars]`;
}

export function buildCodexPrompt(
  prompt: string,
  conversationHistory?: StreamChatParams['conversationHistory'],
): string {
  const normalizedPrompt = normalizePromptText(prompt);
  if (!conversationHistory?.length) {
    return normalizedPrompt || prompt;
  }

  const normalizedHistory = conversationHistory
    .map((entry) => {
      const content = normalizePromptText(entry.content || '');
      if (!content) {
        return null;
      }
      return {
        role: entry.role,
        content: truncatePromptContext(content, MAX_IMPORTED_HISTORY_MESSAGE_CHARS),
      };
    })
    .filter((entry): entry is { role: 'user' | 'assistant'; content: string } => !!entry)
    .filter((entry, index, items) => {
      const previous = items[index - 1];
      return !previous || previous.role !== entry.role || previous.content !== entry.content;
    });

  if (normalizedHistory.length === 0) {
    return normalizedPrompt || prompt;
  }

  const selected: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let totalChars = 0;
  for (let index = normalizedHistory.length - 1; index >= 0; index -= 1) {
    const entry = normalizedHistory[index];
    const nextSize = totalChars + entry.content.length;
    if (
      selected.length >= MAX_IMPORTED_HISTORY_MESSAGES
      || (selected.length > 0 && nextSize > MAX_IMPORTED_HISTORY_TOTAL_CHARS)
    ) {
      break;
    }
    selected.push(entry);
    totalChars = nextSize;
  }
  selected.reverse();

  const transcript = selected
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}:\n${entry.content}`)
    .join('\n\n');

  return [
    'Continue the conversation using the prior transcript as context.',
    'Use the transcript as background only, and continue from the latest user message.',
    '',
    '<conversation_history>',
    transcript,
    '</conversation_history>',
    '',
    '<new_user_message>',
    normalizedPrompt || prompt,
    '</new_user_message>',
  ].join('\n');
}

export function isCurrentTurnPromptRecord(record: string, prompt: string): boolean {
  const normalizedPrompt = normalizePromptText(prompt);
  if (!normalizedPrompt) {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(record) as Record<string, unknown>;
  } catch {
    return false;
  }

  const payload = (parsed.payload ?? {}) as Record<string, unknown>;
  if (
    parsed.type === 'event_msg' &&
    payload.type === 'user_message' &&
    typeof payload.message === 'string'
  ) {
    return normalizePromptText(payload.message) === normalizedPrompt;
  }

  if (
    parsed.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'user' &&
    Array.isArray(payload.content)
  ) {
    const text = payload.content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        const block = item as Record<string, unknown>;
        return block.type === 'input_text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
    return normalizePromptText(text) === normalizedPrompt;
  }

  return false;
}

export function findMatchingRolloutFile(criteria: RolloutMatchCriteria): RolloutMatch | null {
  const matches: Array<{ filePath: string; mtimeMs: number }> = [];

  for (const dir of buildCandidateSessionDirs(criteria.startTimeMs)) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jsonl') || !entry.startsWith('rollout-')) {
        continue;
      }
      if (criteria.resumeSessionId && !entry.includes(criteria.resumeSessionId)) {
        continue;
      }
      const filePath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs + 15_000 < criteria.startTimeMs) {
        continue;
      }
      matches.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const match of matches.slice(0, 48)) {
    const prefix = readPrefix(match.filePath, ROLLOUT_HEAD_SCAN_BYTES);
    const [firstLine = ''] = prefix.split('\n', 1);
    let events;
    try {
      events = parseCodexRolloutRecord(firstLine);
    } catch {
      continue;
    }
    const sessionMeta = events.find((event) => event.kind === 'session');
    if (!sessionMeta) {
      continue;
    }

    try {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      const payload = (parsed.payload ?? {}) as Record<string, unknown>;
      if (payload.cwd !== criteria.workingDirectory) {
        continue;
      }
    } catch {
      continue;
    }

    if (!criteria.resumeSessionId && !rolloutHeadContainsPrompt(prefix, criteria.prompt)) {
      continue;
    }

    return {
      filePath: match.filePath,
      sessionId: sessionMeta.sessionId,
    };
  }

  return null;
}

class JsonlTailReader {
  private position: number;
  private remainder = '';
  private discardLeadingPartialLine: boolean;

  constructor(private readonly filePath: string, startPosition = 0) {
    this.position = Math.max(0, startPosition);
    this.discardLeadingPartialLine = this.position > 0;
  }

  readAvailableLines(): string[] {
    const stat = fs.statSync(this.filePath);
    if (stat.size <= this.position) {
      return [];
    }

    const fd = fs.openSync(this.filePath, 'r');
    try {
      const length = stat.size - this.position;
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, this.position);
      this.position += read;

      let chunk = this.remainder + buffer.subarray(0, read).toString('utf8');
      if (this.discardLeadingPartialLine) {
        const newlineIndex = chunk.indexOf('\n');
        if (newlineIndex === -1) {
          this.remainder = chunk;
          return [];
        }
        chunk = chunk.slice(newlineIndex + 1);
        this.discardLeadingPartialLine = false;
      }

      const parts = chunk.split('\n');
      this.remainder = parts.pop() ?? '';
      return parts.filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }

  flushRemainder(): string[] {
    return this.remainder ? [this.remainder] : [];
  }
}

interface FollowRolloutSummary {
  sessionId?: string;
  usage?: TokenUsage;
  finalAnswer?: string;
  sawEvents: boolean;
  taskCompleted: boolean;
  usedRolloutText: boolean;
  concurrentTurnDetected: boolean;
  concurrentTurnMessage?: string;
}

interface CodexRunSummary {
  sessionId?: string;
  usage?: TokenUsage;
  finalAnswer?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorText: string;
  sawRolloutEvents: boolean;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function appendCapped(buffer: string, chunk: string, maxChars = MAX_CAPTURED_STDIO_CHARS): string {
  if (!chunk) return buffer;
  const next = buffer + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(-maxChars);
}

function truncateInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function shouldFlushStdoutBatch(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.includes('\n')) {
    return true;
  }
  if (text.length >= STDOUT_BATCH_MAX_CHARS) {
    return true;
  }
  return /(?:[ \t]+|[，。！？；：,.!?;:、)\]）】》〉])$/u.test(text);
}

export class StdoutDeltaBatcher {
  private pending = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onFlush: (text: string) => void,
    private readonly idleMs = STDOUT_BATCH_IDLE_MS,
  ) {}

  push(delta: string): void {
    if (!delta) {
      return;
    }
    this.pending += delta;
    if (shouldFlushStdoutBatch(this.pending)) {
      this.flush();
      return;
    }
    this.schedule();
  }

  flush(): void {
    this.clearTimer();
    if (!this.pending) {
      return;
    }
    const text = this.pending;
    this.pending = '';
    this.onFlush(text);
  }

  discard(): void {
    this.clearTimer();
    this.pending = '';
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.idleMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

interface AppServerTurnState {
  bridgeSessionId: string;
  threadId: string;
  turnId?: string;
  controller: ReadableStreamDefaultController<string>;
  params: StreamChatParams;
  done: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  itemPhases: Map<string, 'commentary' | 'final_answer'>;
  emittedToolUses: Set<string>;
  emittedToolResults: Set<string>;
  commandOutputs: Map<string, string>;
  finalAnswer?: string;
  usage?: TokenUsage;
}

interface AppServerRunSummary {
  sessionId?: string;
  usage?: TokenUsage;
  finalAnswer?: string;
}

interface AppServerThreadItem {
  type?: string;
  id?: string;
  phase?: 'commentary' | 'final_answer' | null;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  contentItems?: unknown[] | null;
  success?: boolean | null;
}

function buildAppServerSandboxMode(permissionMode?: string): 'read-only' | 'workspace-write' {
  return permissionMode === 'plan' ? 'read-only' : 'workspace-write';
}

function buildAppServerApprovalPolicy(): 'on-request' {
  return 'on-request';
}

function hasSessionApprovalSuggestion(updatedPermissions?: unknown[]): boolean {
  return Array.isArray(updatedPermissions) && updatedPermissions.length > 0;
}

function buildCommandApprovalDecision(
  behavior: 'allow' | 'deny',
  updatedPermissions?: unknown[],
  availableDecisions?: unknown,
): 'accept' | 'acceptForSession' | 'decline' {
  if (behavior !== 'allow') {
    return 'decline';
  }

  const supportsSession = Array.isArray(availableDecisions)
    && availableDecisions.some((decision) => decision === 'acceptForSession');

  if (supportsSession && hasSessionApprovalSuggestion(updatedPermissions)) {
    return 'acceptForSession';
  }

  return 'accept';
}

function buildFileChangeApprovalDecision(
  behavior: 'allow' | 'deny',
  updatedPermissions?: unknown[],
): 'accept' | 'acceptForSession' | 'decline' {
  if (behavior !== 'allow') {
    return 'decline';
  }
  return hasSessionApprovalSuggestion(updatedPermissions) ? 'acceptForSession' : 'accept';
}

function buildGrantedPermissionProfile(requested: unknown, allow: boolean): Record<string, unknown> {
  if (!allow || !requested || typeof requested !== 'object') {
    return {};
  }
  const record = requested as Record<string, unknown>;
  const granted: Record<string, unknown> = {};
  if (record.network !== undefined && record.network !== null) {
    granted.network = record.network;
  }
  if (record.fileSystem !== undefined && record.fileSystem !== null) {
    granted.fileSystem = record.fileSystem;
  }
  return granted;
}

function buildToolResultContent(item: AppServerThreadItem, fallbackOutput = ''): string {
  switch (item.type) {
    case 'commandExecution': {
      const output = fallbackOutput || (typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '');
      if (output.trim()) {
        return truncateInline(output, MAX_TOOL_RESULT_CHARS);
      }
      if (typeof item.exitCode === 'number') {
        return `Exit code ${item.exitCode}`;
      }
      return item.status === 'declined' ? 'Declined' : 'Done';
    }

    case 'fileChange': {
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      if (count > 0) {
        return `${count} file change${count === 1 ? '' : 's'}`;
      }
      return item.status === 'declined' ? 'Declined' : 'Done';
    }

    case 'mcpToolCall': {
      if (item.error) {
        return truncateInline(JSON.stringify(item.error), MAX_TOOL_RESULT_CHARS);
      }
      if (item.result != null) {
        return truncateInline(JSON.stringify(item.result), MAX_TOOL_RESULT_CHARS);
      }
      return 'Done';
    }

    case 'dynamicToolCall': {
      if (Array.isArray(item.contentItems) && item.contentItems.length > 0) {
        return truncateInline(JSON.stringify(item.contentItems), MAX_TOOL_RESULT_CHARS);
      }
      if (item.success === false) {
        return 'Failed';
      }
      return 'Done';
    }

    default:
      return fallbackOutput ? truncateInline(fallbackOutput, MAX_TOOL_RESULT_CHARS) : 'Done';
  }
}

function buildToolUsePayload(item: AppServerThreadItem): { name: string; input: unknown } | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: {
          command: item.command || '',
          cwd: item.cwd || '',
        },
      };

    case 'fileChange':
      return {
        name: 'Edit',
        input: Array.isArray(item.changes) ? { changes: item.changes } : {},
      };

    case 'mcpToolCall':
      return {
        name: item.tool || 'mcp_tool_call',
        input: {
          server: item.server || '',
          arguments: item.arguments ?? {},
        },
      };

    case 'dynamicToolCall':
      return {
        name: item.tool || 'dynamic_tool_call',
        input: item.arguments ?? {},
      };

    default:
      return null;
  }
}

function mapThreadTokenUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const total = (payload as Record<string, unknown>).last;
  if (!total || typeof total !== 'object') {
    return undefined;
  }
  const breakdown = total as Record<string, unknown>;
  return {
    input_tokens: Number(breakdown.inputTokens ?? 0),
    output_tokens: Number(breakdown.outputTokens ?? 0),
    cache_read_input_tokens: Number(breakdown.cachedInputTokens ?? 0),
  };
}

function extractTurnErrorMessage(errorPayload: unknown): string {
  if (!errorPayload || typeof errorPayload !== 'object') {
    return 'Codex turn failed';
  }
  const error = errorPayload as Record<string, unknown>;
  const message = typeof error.message === 'string' ? error.message : 'Codex turn failed';
  const details = typeof error.additionalDetails === 'string' && error.additionalDetails.trim()
    ? error.additionalDetails
    : '';
  return details ? `${message}\n${details}` : message;
}

export class CodexProvider implements LLMProvider {
  private readonly threadIds = new Map<string, string>();
  private readonly streamedTextBySession = new Map<string, string>();
  private readonly activeTurns = new Map<string, AppServerTurnState>();
  private appServer: CodexAppServerClient | null = null;
  private appServerSubscribed = false;

  constructor(private readonly pendingPerms: PendingPermissions) {
    void this.pendingPerms;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const provider = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            let resumeSessionId = params.sdkSessionId || provider.threadIds.get(params.sessionId);
            if (resumeSessionId && looksLikeNonCodexModel(params.model)) {
              resumeSessionId = undefined;
            }

            const summary = await provider.runCodexAppServer(controller, params, resumeSessionId, tempFiles);

            if (summary.sessionId) {
              provider.threadIds.set(params.sessionId, summary.sessionId);
            }

            if (summary.finalAnswer) {
              provider.emitMissingFinalText(controller, summary.finalAnswer, params.sessionId);
            }

            if (!params.abortController?.signal.aborted) {
              controller.enqueue(sseEvent('result', {
                ...(summary.usage ? { usage: summary.usage } : {}),
                ...(summary.sessionId ? { session_id: summary.sessionId } : {}),
              }));
            }
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(sseEvent('error', humanizeCodexError(message)));
            controller.close();
          } finally {
            for (const tempFile of tempFiles) {
              try {
                fs.unlinkSync(tempFile);
              } catch {
                // ignore cleanup failures
              }
            }
          }
        })();
      },
    });
  }

  private emitMissingFinalText(
    controller: ReadableStreamDefaultController<string>,
    finalAnswer: string,
    bridgeSessionId: string,
  ): void {
    const streamed = this.streamedTextBySession.get(bridgeSessionId) || '';
    if (!finalAnswer || !finalAnswer.startsWith(streamed)) {
      return;
    }

    const suffix = finalAnswer.slice(streamed.length);
    if (suffix) {
      controller.enqueue(sseEvent('text', suffix));
      this.streamedTextBySession.set(bridgeSessionId, finalAnswer);
    }
  }

  private async getAppServer(): Promise<CodexAppServerClient> {
    if (!this.appServer) {
      const codexPath = resolveCodexCliPath();
      if (!codexPath) {
        throw new Error(
          '[CodexProvider] Cannot find the `codex` CLI executable. ' +
          'Install it with `npm install -g @openai/codex` or set CODEX_FEISHU_CODEX_EXECUTABLE=/path/to/codex',
        );
      }
      this.appServer = new CodexAppServerClient(codexPath, createCodexEnv(), process.cwd());
    }

    if (!this.appServerSubscribed) {
      this.appServer.subscribe((message) => {
        void this.handleAppServerMessage(message);
      });
      this.appServerSubscribed = true;
    }

    await this.appServer.request('config/read', {});
    return this.appServer;
  }

  private async runCodexAppServer(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    resumeSessionId: string | undefined,
    tempFiles: string[],
  ): Promise<AppServerRunSummary> {
    const client = await this.getAppServer();
    const workingDirectory = params.workingDirectory || process.cwd();
    const model = looksLikeNonCodexModel(params.model) ? undefined : params.model;
    const imagePaths = this.materializeImages(params.files, tempFiles);
    const prompt = resumeSessionId
      ? params.prompt
      : buildCodexPrompt(params.prompt, params.conversationHistory);
    const approvalPolicy = buildAppServerApprovalPolicy();
    const sandbox = buildAppServerSandboxMode(params.permissionMode);

    this.streamedTextBySession.set(params.sessionId, '');

    const threadResponse = resumeSessionId
      ? await client.request<Record<string, unknown>>('thread/resume', {
          threadId: resumeSessionId,
          cwd: workingDirectory,
          approvalPolicy,
          sandbox,
          ...(model ? { model } : {}),
          persistExtendedHistory: true,
        })
      : await client.request<Record<string, unknown>>('thread/start', {
          cwd: workingDirectory,
          approvalPolicy,
          sandbox,
          ...(model ? { model } : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        });

    const thread = (threadResponse.thread ?? {}) as Record<string, unknown>;
    const threadId = typeof thread.id === 'string' ? thread.id : resumeSessionId;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id');
    }

    controller.enqueue(sseEvent('status', { session_id: threadId }));

    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const state: AppServerTurnState = {
      bridgeSessionId: params.sessionId,
      threadId,
      controller,
      params,
      done: {
        promise: done,
        resolve: resolveDone,
        reject: rejectDone,
      },
      itemPhases: new Map<string, 'commentary' | 'final_answer'>(),
      emittedToolUses: new Set<string>(),
      emittedToolResults: new Set<string>(),
      commandOutputs: new Map<string, string>(),
    };
    this.activeTurns.set(threadId, state);

    const onAbort = () => {
      if (state.turnId) {
        void client.request('turn/interrupt', {
          threadId,
          turnId: state.turnId,
        }).catch(() => {
          // ignore abort races
        });
      }
    };
    params.abortController?.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const turnResponse = await client.request<Record<string, unknown>>('turn/start', {
        threadId,
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
        ],
        cwd: workingDirectory,
        approvalPolicy,
        sandboxPolicy: this.buildTurnSandboxPolicy(params.permissionMode),
        ...(model ? { model } : {}),
      });

      const turn = (turnResponse.turn ?? {}) as Record<string, unknown>;
      if (typeof turn.id === 'string') {
        state.turnId = turn.id;
      }

      await state.done.promise;
    } finally {
      params.abortController?.signal.removeEventListener('abort', onAbort);
      this.activeTurns.delete(threadId);
    }

    if (params.abortController?.signal.aborted) {
      return {
        sessionId: threadId,
        usage: state.usage,
        finalAnswer: state.finalAnswer,
      };
    }

    return {
      sessionId: threadId,
      usage: state.usage,
      finalAnswer: state.finalAnswer,
    };
  }

  private buildTurnSandboxPolicy(permissionMode?: string): Record<string, unknown> {
    if (permissionMode === 'plan') {
      return {
        type: 'readOnly',
        access: { type: 'fullAccess' },
        networkAccess: false,
      };
    }

      return {
        type: 'workspaceWrite',
        writableRoots: [],
        readOnlyAccess: { type: 'fullAccess' },
        excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
      networkAccess: false,
    };
  }

  private async handleAppServerMessage(message: AppServerJsonRpcMessage): Promise<void> {
    if (message.method === '__connection_closed__') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const detail = typeof params.message === 'string' ? params.message : 'Codex app-server connection closed';
      for (const [, state] of this.activeTurns) {
        state.done.reject(new Error(detail));
      }
      return;
    }

    const params = message.params && typeof message.params === 'object'
      ? message.params as Record<string, unknown>
      : null;
    if (!params) {
      return;
    }
    const threadId = params && typeof params.threadId === 'string'
      ? params.threadId
      : null;
    if (!threadId) {
      return;
    }

    const state = this.activeTurns.get(threadId);
    if (!state) {
      return;
    }

    switch (message.method) {
      case 'turn/started':
        if (params.turn && typeof params.turn === 'object') {
          const turn = params.turn as Record<string, unknown>;
          if (typeof turn.id === 'string') {
            state.turnId = turn.id;
          }
        }
        state.params.onRuntimeStatusChange?.('running');
        break;

      case 'thread/tokenUsage/updated':
        state.usage = mapThreadTokenUsage(params.tokenUsage) || state.usage;
        break;

      case 'item/started':
        this.handleStartedItem(state, params.item as AppServerThreadItem);
        break;

      case 'item/agentMessage/delta':
        this.handleTextDelta(state, String(params.delta ?? ''), params.itemId);
        break;

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.handleTextDelta(state, String(params.delta ?? ''), params.itemId);
        break;

      case 'item/commandExecution/outputDelta':
        this.handleCommandOutputDelta(state, params.itemId, String(params.delta ?? ''));
        break;

      case 'item/completed':
        this.handleCompletedItem(state, params.item as AppServerThreadItem);
        break;

      case 'error':
        state.done.reject(new Error(extractTurnErrorMessage(params.error)));
        break;

      case 'turn/completed':
        state.params.onRuntimeStatusChange?.('idle');
        {
          const turn = params.turn && typeof params.turn === 'object'
            ? params.turn as Record<string, unknown>
            : {};
          const error = this.handleCompletedTurn(state, turn);
          if (error) {
            state.done.reject(error);
          } else {
            state.done.resolve();
          }
        }
        break;

      case 'item/commandExecution/requestApproval':
        if (message.id !== undefined) {
          await this.handleCommandApprovalRequest(state, message.id, params);
        }
        break;

      case 'item/fileChange/requestApproval':
        if (message.id !== undefined) {
          await this.handleFileChangeApprovalRequest(state, message.id, params);
        }
        break;

      case 'item/permissions/requestApproval':
        if (message.id !== undefined) {
          await this.handlePermissionsApprovalRequest(state, message.id, params);
        }
        break;

      default:
        break;
    }
  }

  private handleStartedItem(state: AppServerTurnState, item: AppServerThreadItem): void {
    if (typeof item.id === 'string' && (item.phase === 'commentary' || item.phase === 'final_answer')) {
      state.itemPhases.set(item.id, item.phase);
    }

    if (typeof item.id !== 'string' || state.emittedToolUses.has(item.id)) {
      return;
    }

    const payload = buildToolUsePayload(item);
    if (!payload) {
      return;
    }

    state.emittedToolUses.add(item.id);
    state.controller.enqueue(sseEvent('tool_use', {
      id: item.id,
      name: payload.name,
      input: payload.input,
    }));
  }

  private handleCompletedItem(state: AppServerTurnState, item: AppServerThreadItem): void {
    if (item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') {
      state.finalAnswer = item.text;
      return;
    }

    if (typeof item.id !== 'string' || state.emittedToolResults.has(item.id)) {
      return;
    }

    const payload = buildToolUsePayload(item);
    if (!payload) {
      return;
    }

    state.emittedToolResults.add(item.id);
    state.controller.enqueue(sseEvent('tool_result', {
      tool_use_id: item.id,
      content: buildToolResultContent(item, state.commandOutputs.get(item.id) || ''),
      is_error: item.status === 'failed' || item.status === 'declined' || (typeof item.success === 'boolean' && !item.success),
    }));
  }

  private handleCompletedTurn(state: AppServerTurnState, turn: Record<string, unknown>): Error | null {
    const items = Array.isArray(turn.items) ? turn.items as AppServerThreadItem[] : [];
    for (const item of items) {
      this.handleCompletedItem(state, item);
      if (item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') {
        state.finalAnswer = item.text;
      }
    }

    if (turn.error) {
      return new Error(extractTurnErrorMessage(turn.error));
    }

    return null;
  }

  private handleTextDelta(
    state: AppServerTurnState,
    delta: string,
    itemId: unknown,
  ): void {
    if (!delta) {
      return;
    }

    if (typeof itemId === 'string') {
      const phase = state.itemPhases.get(itemId);
      if (phase === 'final_answer') {
        state.finalAnswer = `${state.finalAnswer || ''}${delta}`;
      }
    }

    state.controller.enqueue(sseEvent('text', delta));
    this.appendStreamedText(state.bridgeSessionId, delta);
  }

  private handleCommandOutputDelta(
    state: AppServerTurnState,
    itemId: unknown,
    delta: string,
  ): void {
    if (typeof itemId !== 'string' || !delta) {
      return;
    }
    const current = state.commandOutputs.get(itemId) || '';
    state.commandOutputs.set(
      itemId,
      appendCapped(current, delta, MAX_TOOL_RESULT_CHARS),
    );
  }

  private async handleCommandApprovalRequest(
    state: AppServerTurnState,
    requestId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const permissionRequestId = String(requestId);
    state.controller.enqueue(sseEvent('permission_request', {
      permissionRequestId,
      toolName: 'Bash',
      toolInput: {
        command: params.command ?? '',
        cwd: params.cwd ?? '',
        reason: params.reason ?? '',
      },
      suggestions: Array.isArray(params.availableDecisions) && params.availableDecisions.some((decision) => decision === 'acceptForSession')
        ? [{ scope: 'session' }]
        : [],
    }));

    const resolution = await this.pendingPerms.waitFor(permissionRequestId);
    const client = await this.getAppServer();
    await client.respond(requestId, {
      decision: buildCommandApprovalDecision(
        resolution.behavior,
        resolution.updatedPermissions,
        params.availableDecisions,
      ),
    });
  }

  private async handleFileChangeApprovalRequest(
    state: AppServerTurnState,
    requestId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const permissionRequestId = String(requestId);
    state.controller.enqueue(sseEvent('permission_request', {
      permissionRequestId,
      toolName: 'Edit',
      toolInput: {
        reason: params.reason ?? '',
        grantRoot: params.grantRoot ?? '',
      },
      suggestions: [{ scope: 'session' }],
    }));

    const resolution = await this.pendingPerms.waitFor(permissionRequestId);
    const client = await this.getAppServer();
    await client.respond(requestId, {
      decision: buildFileChangeApprovalDecision(
        resolution.behavior,
        resolution.updatedPermissions,
      ),
    });
  }

  private async handlePermissionsApprovalRequest(
    state: AppServerTurnState,
    requestId: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const permissionRequestId = String(requestId);
    state.controller.enqueue(sseEvent('permission_request', {
      permissionRequestId,
      toolName: 'Permissions',
      toolInput: {
        reason: params.reason ?? '',
        permissions: params.permissions ?? {},
      },
      suggestions: [{ scope: 'session' }],
    }));

    const resolution = await this.pendingPerms.waitFor(permissionRequestId);
    const client = await this.getAppServer();
    await client.respond(requestId, {
      permissions: buildGrantedPermissionProfile(params.permissions, resolution.behavior === 'allow'),
      scope: hasSessionApprovalSuggestion(resolution.updatedPermissions) ? 'session' : 'turn',
    });
  }

  private async runCodexCli(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    resumeSessionId: string | undefined,
    tempFiles: string[],
  ): Promise<CodexRunSummary> {
    const codexPath = resolveCodexCliPath();
    if (!codexPath) {
      throw new Error(
        '[CodexProvider] Cannot find the `codex` CLI executable. ' +
        'Install it with `npm install -g @openai/codex` or set CODEX_FEISHU_CODEX_EXECUTABLE=/path/to/codex',
      );
    }

    const workingDirectory = params.workingDirectory || process.cwd();
    const imagePaths = this.materializeImages(params.files, tempFiles);
    const model = looksLikeNonCodexModel(params.model) ? undefined : params.model;
    const prompt = resumeSessionId
      ? params.prompt
      : buildCodexPrompt(params.prompt, params.conversationHistory);
    this.streamedTextBySession.set(params.sessionId, '');
    const codexArgs = buildCodexCliArgs({
      codexPath,
      prompt,
      resumeSessionId,
      model,
      permissionMode: params.permissionMode,
      imagePaths,
    });
    const ptyInvocation = buildPtyInvocation(codexPath, codexArgs);
    const child = spawn(ptyInvocation.command, ptyInvocation.args, {
      cwd: workingDirectory,
      env: createCodexEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutParser = new CodexCliStdoutParser();
    const startTimeMs = Date.now();
    let stdoutRaw = '';
    let stderrRaw = '';
    let aborted = false;
    let completionRequested = false;
    let rolloutTextMode = false;
    let lastRolloutText = '';

    const onAbort = () => {
      aborted = true;
      this.interruptChild(child);
    };
    params.abortController?.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutRaw = appendCapped(stdoutRaw, text);
      if (!rolloutTextMode && !completionRequested) {
        stdoutParser.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrRaw = appendCapped(stderrRaw, chunk.toString('utf8'));
    });

    const exitPromise = this.waitForExit(child);
    const requestCompletion = (finalAnswer?: string) => {
      if (completionRequested || aborted) {
        return;
      }
      completionRequested = true;
      if (finalAnswer) {
        this.emitMissingFinalText(controller, finalAnswer, params.sessionId);
      }
      this.requestChildCompletion(child);
    };
    const emitRolloutText = (text: string) => {
      rolloutTextMode = true;
      if (!text) {
        return;
      }
      const streamed = this.streamedTextBySession.get(params.sessionId) || '';
      let delta = '';

      if (text === lastRolloutText) {
        return;
      }

      if (lastRolloutText && text.startsWith(lastRolloutText)) {
        delta = text.slice(lastRolloutText.length);
      } else if (streamed && text.startsWith(streamed)) {
        delta = text.slice(streamed.length);
      } else {
        delta = `${streamed ? '\n\n' : ''}${text}`;
      }

      lastRolloutText = text;
      if (!delta) {
        return;
      }

      controller.enqueue(sseEvent('text', delta));
      this.rememberStreamedText(params.sessionId, `${streamed}${delta}`);
    };
    const rolloutPromise = this.followRollout(controller, {
      startTimeMs,
      prompt,
      workingDirectory,
      resumeSessionId,
      processDone: exitPromise,
      onTaskComplete: requestCompletion,
      onRolloutText: emitRolloutText,
    });

    const [exit, rollout] = await Promise.all([exitPromise, rolloutPromise]);

    stdoutParser.flush();

    const streamedText = this.streamedTextBySession.get(params.sessionId) || '';
    const errorText = [stderrRaw, cleanTerminalOutput(stdoutRaw)]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    const concurrentTurnError = rollout.concurrentTurnDetected
      ? `Imported Codex thread became active elsewhere while IM was waiting${rollout.concurrentTurnMessage ? `: ${truncateInline(rollout.concurrentTurnMessage, 120)}` : ''}. The IM thread will detach from that shared session on the next message.`
      : '';

    if (!rollout.usedRolloutText && !aborted && rollout.finalAnswer && rollout.finalAnswer.startsWith(streamedText)) {
      const suffix = rollout.finalAnswer.slice(streamedText.length);
      if (suffix) {
        controller.enqueue(sseEvent('text', suffix));
        this.rememberStreamedText(params.sessionId, rollout.finalAnswer);
      }
    }

    params.abortController?.signal.removeEventListener('abort', onAbort);

    return {
      sessionId: rollout.sessionId,
      usage: rollout.usage,
      finalAnswer: rollout.finalAnswer,
      exitCode: concurrentTurnError ? 1 : (aborted || rollout.taskCompleted ? 0 : exit.code),
      signal: exit.signal,
      errorText: concurrentTurnError || errorText,
      sawRolloutEvents: rollout.sawEvents,
    };
  }

  private materializeImages(files: StreamChatParams['files'], tempFiles: string[]): string[] {
    const imageFiles = files?.filter((file) => file.type.startsWith('image/')) ?? [];
    const paths: string[] = [];

    for (const file of imageFiles) {
      const ext = MIME_EXT[file.type] || '.png';
      const tempFilePath = path.join(
        os.tmpdir(),
        `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
      );
      fs.writeFileSync(tempFilePath, Buffer.from(file.data, 'base64'));
      tempFiles.push(tempFilePath);
      paths.push(tempFilePath);
    }

    return paths;
  }

  private rememberStreamedText(bridgeSessionId: string, text: string): void {
    this.streamedTextBySession.set(bridgeSessionId, text);
  }

  private appendStreamedText(bridgeSessionId: string, delta: string): void {
    const current = this.streamedTextBySession.get(bridgeSessionId) || '';
    this.streamedTextBySession.set(bridgeSessionId, `${current}${delta}`);
  }

  private async followRollout(
    controller: ReadableStreamDefaultController<string>,
    options: {
      startTimeMs: number;
      prompt: string;
      workingDirectory: string;
      resumeSessionId?: string;
      processDone: Promise<ChildExitResult>;
      onTaskComplete?: (finalAnswer?: string) => void;
      onRolloutText?: (text: string) => void;
    },
  ): Promise<FollowRolloutSummary> {
    const processDone = { value: false };
    void options.processDone.finally(() => {
      processDone.value = true;
    });

    let tailer: JsonlTailReader | null = null;
    let sessionId = options.resumeSessionId;
    let usage: TokenUsage | undefined;
    let finalAnswer: string | undefined;
    let sawEvents = false;
    let taskCompleted = false;
    let usedRolloutText = false;
    let concurrentTurnDetected = false;
    let concurrentTurnMessage = '';
    const emittedToolUses = new Set<string>();
    const emittedToolResults = new Set<string>();
    let settlePasses = 0;
    let awaitingCurrentPrompt = true;
    const minTurnTimestampMs = options.startTimeMs - 5_000;

    while (!processDone.value || settlePasses < ROLLOUT_SETTLE_PASSES) {
      if (!tailer) {
        const match = findMatchingRolloutFile({
          startTimeMs: options.startTimeMs,
          prompt: options.prompt,
          workingDirectory: options.workingDirectory,
          resumeSessionId: options.resumeSessionId,
        });
        if (match) {
          let startPosition = 0;
          if (options.resumeSessionId) {
            try {
              const stat = fs.statSync(match.filePath);
              startPosition = Math.max(0, stat.size - RESUME_ROLLOUT_TAIL_BYTES);
            } catch {
              startPosition = 0;
            }
          }
          tailer = new JsonlTailReader(match.filePath, startPosition);
          sessionId = match.sessionId;
          controller.enqueue(sseEvent('status', { session_id: match.sessionId }));
        } else {
          if (processDone.value) {
            settlePasses += 1;
          }
          await sleep(ROLLOUT_SCAN_INTERVAL_MS);
          continue;
        }
      }

      let sawNewData = false;
      try {
        let lines = tailer.readAvailableLines();
        if (lines.length > 0) {
          sawNewData = true;
        }

        lines = lines.filter((line) => {
          const timestampMs = parseRecordTimestampMs(line);
          return timestampMs == null || timestampMs >= minTurnTimestampMs;
        });

        if (awaitingCurrentPrompt && lines.length > 0) {
          let lastPromptIndex = -1;
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (isCurrentTurnPromptRecord(lines[index], options.prompt)) {
              lastPromptIndex = index;
              break;
            }
          }
          if (lastPromptIndex >= 0) {
            lines = lines.slice(lastPromptIndex + 1);
            awaitingCurrentPrompt = false;
          } else if (lines.some((line) => {
            const timestampMs = parseRecordTimestampMs(line);
            return timestampMs != null && timestampMs >= options.startTimeMs;
          })) {
            // The prompt line likely fell just before our tail window. Once we
            // see same-turn records newer than the process start, stop waiting
            // for the prompt and process the fresh events we do have.
            awaitingCurrentPrompt = false;
          } else {
            lines = [];
          }
        }

        for (const line of lines) {
          const rawUserMessage = extractUserMessageText(line);
          const timestampMs = parseRecordTimestampMs(line);
          if (
            rawUserMessage &&
            timestampMs != null &&
            timestampMs >= options.startTimeMs &&
            normalizePromptText(rawUserMessage) !== normalizePromptText(options.prompt)
          ) {
            concurrentTurnDetected = true;
            concurrentTurnMessage = rawUserMessage;
            options.onTaskComplete?.();
            break;
          }

          sawEvents = true;
          for (const event of parseCodexRolloutRecord(line)) {
            switch (event.kind) {
              case 'session':
                sessionId = event.sessionId;
                break;

              case 'tool_use':
                if (!emittedToolUses.has(event.id)) {
                  emittedToolUses.add(event.id);
                  controller.enqueue(sseEvent('tool_use', {
                    id: event.id,
                    name: event.name,
                    input: event.input,
                  }));
                }
                break;

              case 'tool_result':
                if (!emittedToolResults.has(event.id)) {
                  emittedToolResults.add(event.id);
                  controller.enqueue(sseEvent('tool_result', {
                    tool_use_id: event.id,
                    content: event.content,
                    is_error: event.isError,
                  }));
                }
                break;

              case 'usage':
                usage = event.usage;
                break;

              case 'commentary':
                usedRolloutText = true;
                options.onRolloutText?.(event.text);
                break;

              case 'final_answer':
                if (event.text === finalAnswer) {
                  break;
                }
                finalAnswer = event.text;
                usedRolloutText = true;
                options.onRolloutText?.(event.text);
                break;

              case 'task_complete':
                taskCompleted = true;
                if (event.lastAgentMessage && !finalAnswer) {
                  finalAnswer = event.lastAgentMessage;
                }
                options.onTaskComplete?.(finalAnswer);
                break;
            }
          }
        }

        if (concurrentTurnDetected) {
          break;
        }
      } catch {
        break;
      }

      if (processDone.value) {
        settlePasses = sawNewData ? 0 : settlePasses + 1;
      }

      await sleep(ROLLOUT_SETTLE_INTERVAL_MS);
    }

    if (tailer) {
      for (const line of tailer.flushRemainder()) {
        for (const event of parseCodexRolloutRecord(line)) {
          if (event.kind === 'usage') {
            usage = event.usage;
          } else if (event.kind === 'final_answer') {
            finalAnswer = event.text;
          } else if (event.kind === 'task_complete') {
            taskCompleted = true;
            if (event.lastAgentMessage && !finalAnswer) {
              finalAnswer = event.lastAgentMessage;
            }
          }
        }
      }
    }

    return {
      sessionId,
      usage,
      finalAnswer,
      sawEvents,
      taskCompleted,
      usedRolloutText,
      concurrentTurnDetected,
      concurrentTurnMessage,
    };
  }

  private waitForExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitResult> {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  private interruptChild(child: ChildProcessWithoutNullStreams): void {
    try {
      child.stdin.write('\x03');
    } catch {
      // ignore
    }

    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill('SIGINT');
        } catch {
          // ignore
        }
      }
    }, 250);

    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 1_500);
  }

  private requestChildCompletion(child: ChildProcessWithoutNullStreams): void {
    try {
      if (!child.stdin.destroyed) {
        child.stdin.write('/exit\n');
      }
    } catch {
      // ignore
    }

    setTimeout(() => {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.write('\x04');
        }
      } catch {
        // ignore
      }
    }, 300);

    setTimeout(() => {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
      } catch {
        // ignore
      }
    }, 600);

    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        this.interruptChild(child);
      }
    }, 1_500);
  }
}
