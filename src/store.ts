/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.codex-feishu/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from './bridge/contracts.js';
import type { ChannelBinding, ChannelType } from './bridge/contracts.js';
import { BRIDGE_HOME } from './config.js';
import { parseCodexRolloutRecord } from './codex-cli-stream.js';

const DATA_DIR = path.join(BRIDGE_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const CODEX_SESSION_INDEX_PATH = path.join(CODEX_HOME, 'session_index.jsonl');
const MAX_STORED_MESSAGE_CHARS = 160_000;
const LOCAL_THREAD_ANALYSIS_TAIL_BYTES = 2 * 1024 * 1024;
const LOCAL_THREAD_BUSY_STALE_MS = 30 * 60 * 1000;
const LOCAL_THREAD_FOLLOW_INTERVAL_MS = 250;
const LOCAL_THREAD_WAITING_APPROVAL_IDLE_MS = 60 * 1000;

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
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

function extractRolloutUserMessageText(record: string): string | null {
  try {
    const parsed = JSON.parse(record) as Record<string, unknown>;
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
  } catch {
    return null;
  }
  return null;
}

function readTailLines(filePath: string, maxBytes: number): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    let chunk = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex === -1) {
        return [];
      }
      chunk = chunk.slice(newlineIndex + 1);
    }
    return chunk.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

class JsonlTailReader {
  private position: number;
  private remainder = '';
  private discardLeadingPartialLine: boolean;

  constructor(private readonly filePath: string, startPosition = 0) {
    this.position = Math.max(0, startPosition);
    this.discardLeadingPartialLine = this.shouldDiscardLeadingPartialLine();
  }

  private shouldDiscardLeadingPartialLine(): boolean {
    if (this.position <= 0) {
      return false;
    }

    try {
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const buffer = Buffer.alloc(1);
        const read = fs.readSync(fd, buffer, 0, 1, this.position - 1);
        if (read <= 0) {
          return false;
        }
        return buffer[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return true;
    }
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendRolloutPreviewText(
  currentText: string,
  lastRolloutText: string,
  nextText: string,
): { currentText: string; lastRolloutText: string } {
  if (!nextText) {
    return { currentText, lastRolloutText };
  }

  if (!currentText) {
    return { currentText: nextText, lastRolloutText: nextText };
  }

  if (nextText === lastRolloutText || nextText === currentText) {
    return { currentText, lastRolloutText: nextText };
  }

  if (lastRolloutText && nextText.startsWith(lastRolloutText)) {
    return {
      currentText: `${currentText}${nextText.slice(lastRolloutText.length)}`,
      lastRolloutText: nextText,
    };
  }

  if (nextText.startsWith(currentText)) {
    return {
      currentText: nextText,
      lastRolloutText: nextText,
    };
  }

  return {
    currentText: `${currentText}\n\n${nextText}`,
    lastRolloutText: nextText,
  };
}

function looksLikeStructuredPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('[{"type":') || trimmed.startsWith('<!--files:');
}

function stripFileAttachmentMetadata(content: string): string {
  return content.replace(/^<!--files:[\s\S]*?-->/, '').trim();
}

function extractRenderableText(content: string): string {
  const trimmed = stripFileAttachmentMetadata(content);
  if (!trimmed) return '';
  if (trimmed.startsWith('[{"type":')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ type?: string; text?: string }>;
      const textParts = parsed
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text!.trim())
        .filter(Boolean);
      return textParts.join('\n\n').trim();
    } catch {
      return '';
    }
  }
  if (looksLikeStructuredPayload(trimmed)) {
    return '';
  }
  return trimmed;
}

function extractPreviewText(content: string): string {
  const trimmed = extractRenderableText(content);
  if (!trimmed) return '';
  return normalizeWhitespace(trimmed);
}

function isUsefulUserPreview(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === '[ok]') return false;
  if (normalized === 'hi' || normalized === 'hello' || normalized === 'hello!') return false;
  if (normalized.startsWith('<environment_context>')) return false;
  if (normalized.startsWith('<app-context>')) return false;
  if (normalized.startsWith('<collaboration_mode>')) return false;
  if (normalized.startsWith('<skills_instructions>')) return false;
  if (normalized.startsWith('reply with exactly ')) return false;
  if (normalized.startsWith('/')) return false;
  return true;
}

function isUsefulConversationPreview(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('<environment_context>')) return false;
  if (normalized.startsWith('<app-context>')) return false;
  if (normalized.startsWith('<collaboration_mode>')) return false;
  if (normalized.startsWith('<skills_instructions>')) return false;
  return true;
}

function isUsefulThreadListPreview(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('threads ')) return false;
  if (normalized.includes('&nbsp;')) return false;
  if (normalized.includes('切换线程')) return false;
  if (normalized.includes('线程列表')) return false;
  if (normalized.includes('/thread')) return false;
  if (normalized.includes('/threads')) return false;
  return true;
}

function formatThreadTimestamp(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function truncateStoredMessage(value: string, maxChars = MAX_STORED_MESSAGE_CHARS): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[stored message truncated ${omitted} chars]`;
}

function sanitizeStoredMessage(role: string, content: string): string {
  if (!content) return content;

  const trimmed = content.trim();
  if (trimmed.length <= MAX_STORED_MESSAGE_CHARS) {
    return content;
  }

  const renderable = extractRenderableText(content);
  if (renderable) {
    return truncateStoredMessage(renderable);
  }

  if (role === 'assistant' || role === 'user') {
    return truncateStoredMessage(stripFileAttachmentMetadata(content));
  }

  return truncateStoredMessage(content);
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

interface ThreadRecord {
  id: string;
  channelType: string;
  chatId: string;
  sessionId: string;
  importedSdkSessionId?: string;
  title: string;
  workingDirectory: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface ThreadSummary extends ThreadRecord {
  latestMessagePreview: string;
  latestMessageRole: string;
  latestUserPreview: string;
  lastActiveLabel: string;
  sdkSessionId: string;
  displayId: string;
  source: 'managed' | 'local';
  importable: boolean;
}

interface LocalCodexThread {
  sdkSessionId: string;
  filePath: string;
  title: string;
  workingDirectory: string;
  model: string;
  latestMessagePreview: string;
  latestMessageRole: string;
  latestUserPreview: string;
  lastActiveAt: string;
  originator: string;
  source: string;
}

export interface ThreadDialogue {
  userText: string;
  assistantText: string;
}

interface LocalConversationEvent {
  role: 'user' | 'assistant';
  text: string;
}

export interface ThreadToolState {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  requiresApproval?: boolean;
}

interface BusyLocalThreadState {
  sdkSessionId: string;
  filePath: string;
  prompt: string;
  turnStartedAt: string;
  turnStartedAtMs: number;
  lastActivityAt: string;
  previewText: string;
  finalText: string;
  lastRolloutText: string;
  tools: ThreadToolState[];
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private threads = new Map<string, ThreadRecord>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];
  private localCodexThreadCache:
    | {
        loadedAt: number;
        entries: Map<string, LocalCodexThread>;
      }
    | null = null;

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Threads
    const threads = readJson<Record<string, ThreadRecord>>(
      path.join(DATA_DIR, 'threads.json'),
      {},
    );
    for (const [key, t] of Object.entries(threads)) {
      this.threads.set(key, t);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistThreads(): void {
    writeJson(
      path.join(DATA_DIR, 'threads.json'),
      Object.fromEntries(this.threads),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    let changed = false;
    const sanitized = msgs.map((msg) => {
      const content = sanitizeStoredMessage(msg.role, String(msg.content || ''));
      if (content !== msg.content) {
        changed = true;
        return { ...msg, content };
      }
      return msg;
    });
    this.messages.set(sessionId, sanitized);
    if (changed) {
      this.persistMessages(sessionId);
    }
    return sanitized;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  private threadKey(channelType: string, chatId: string, sessionId: string): string {
    return `${channelType}:${chatId}:${sessionId}`;
  }

  private defaultThreadTitle(sessionId: string, workingDirectory?: string): string {
    const base = workingDirectory ? path.basename(workingDirectory) : 'thread';
    return `${base || 'thread'} · ${sessionId.slice(0, 8)}`;
  }

  private listRolloutFiles(dir: string): string[] {
    const files: string[] = [];
    const visit = (currentDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    };

    visit(dir);
    return files.sort((a, b) => b.localeCompare(a));
  }

  private loadLocalThreadTitleIndex(): Map<string, string> {
    const titles = new Map<string, string>();
    let raw = '';
    try {
      raw = fs.readFileSync(CODEX_SESSION_INDEX_PATH, 'utf-8');
    } catch {
      return titles;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { id?: string; thread_name?: string };
        const sessionId = parsed.id?.trim();
        const title = parsed.thread_name ? normalizeWhitespace(parsed.thread_name) : '';
        if (sessionId && title) {
          titles.set(sessionId, title);
        }
      } catch {
        continue;
      }
    }

    return titles;
  }

  private parseLocalCodexThread(filePath: string, titleIndex?: Map<string, string>): LocalCodexThread | null {
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    let sdkSessionId = '';
    let workingDirectory = '';
    let model = '';
    let lastActiveAt = '';
    let originator = '';
    let source = '';

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as { timestamp?: string };
        if (parsed.timestamp) {
          lastActiveAt = parsed.timestamp;
          break;
        }
      } catch {
        continue;
      }
    }

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          payload?: { id?: string; cwd?: string; model?: string; timestamp?: string };
        };
        if (parsed.type !== 'session_meta') continue;
        sdkSessionId = parsed.payload?.id || '';
        workingDirectory = parsed.payload?.cwd || '';
        model = parsed.payload?.model || '';
        originator = (parsed.payload as { originator?: string }).originator || '';
        source = (parsed.payload as { source?: string }).source || '';
        if (!lastActiveAt) {
          lastActiveAt = parsed.payload?.timestamp || '';
        }
        break;
      } catch {
        continue;
      }
    }

    if (!sdkSessionId) return null;

    let latestUserPreview = '';
    let latestMessagePreview = '';
    let latestMessageRole = '';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as {
          timestamp?: string;
          type?: string;
          payload?: { type?: string; message?: string };
        };
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'user_message') continue;
        const preview = extractPreviewText(parsed.payload?.message || '');
        if (!isUsefulUserPreview(preview)) continue;
        latestUserPreview = preview.slice(0, 120);
        break;
      } catch {
        continue;
      }
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as {
          type?: string;
          payload?: { type?: string; message?: string; phase?: string };
        };
        if (parsed.type !== 'event_msg') continue;
        const eventType = parsed.payload?.type || '';
        if (eventType !== 'user_message' && eventType !== 'agent_message') continue;
        if (eventType === 'agent_message' && parsed.payload?.phase && parsed.payload.phase !== 'final_answer') {
          continue;
        }
        const preview = extractPreviewText(parsed.payload?.message || '');
        if (!isUsefulConversationPreview(preview)) continue;
        latestMessagePreview = preview.slice(0, 120);
        latestMessageRole = eventType === 'agent_message' ? 'assistant' : 'user';
        break;
      } catch {
        continue;
      }
    }

    if (!latestUserPreview) return null;
    if (!isUsefulThreadListPreview(latestUserPreview)) return null;

    return {
      sdkSessionId,
      filePath,
      title: titleIndex?.get(sdkSessionId) || this.defaultThreadTitle(sdkSessionId, workingDirectory),
      workingDirectory,
      model,
      latestMessagePreview,
      latestMessageRole,
      latestUserPreview,
      lastActiveAt,
      originator,
      source,
    };
  }

  private getLocalCodexThreads(): Map<string, LocalCodexThread> {
    const cacheTtlMs = 10_000;
    if (this.localCodexThreadCache && Date.now() - this.localCodexThreadCache.loadedAt < cacheTtlMs) {
      return this.localCodexThreadCache.entries;
    }

    const entries = new Map<string, LocalCodexThread>();
    const titleIndex = this.loadLocalThreadTitleIndex();
    for (const filePath of this.listRolloutFiles(CODEX_SESSIONS_DIR)) {
      const thread = this.parseLocalCodexThread(filePath, titleIndex);
      if (!thread) continue;
      if (entries.has(thread.sdkSessionId)) continue;
      entries.set(thread.sdkSessionId, thread);
    }

    this.localCodexThreadCache = {
      loadedAt: Date.now(),
      entries,
    };
    return entries;
  }

  private getSessionSdkSessionId(sessionId: string): string {
    const session = this.sessions.get(sessionId) as (BridgeSession & { sdk_session_id?: string }) | undefined;
    return session?.sdk_session_id || '';
  }

  private getRelevantChatWorkdirs(channelType: string, chatId: string): Set<string> {
    const workdirs = new Set<string>();
    const binding = this.getChannelBinding(channelType, chatId);
    if (binding?.workingDirectory) {
      workdirs.add(binding.workingDirectory);
    }
    for (const thread of this.threads.values()) {
      if (thread.channelType !== channelType || thread.chatId !== chatId) continue;
      if (thread.workingDirectory) {
        workdirs.add(thread.workingDirectory);
      }
    }
    if (workdirs.size === 0) {
      const defaultWorkDir = this.settings.get('default_workdir');
      if (defaultWorkDir) {
        workdirs.add(defaultWorkDir);
      }
    }
    return workdirs;
  }

  private getThreadSourceSdkSessionId(record: ThreadRecord): string {
    return this.getSessionSdkSessionId(record.sessionId) || record.importedSdkSessionId || '';
  }

  private getDesktopPrioritySdkSessionId(record: ThreadRecord): string {
    return this.getSessionSdkSessionId(record.sessionId) || record.importedSdkSessionId || '';
  }

  private buildManagedThreadSummary(record: ThreadRecord): ThreadSummary {
    const sdkSessionId = this.getSessionSdkSessionId(record.sessionId);
    const sourceSdkSessionId = this.getThreadSourceSdkSessionId(record);
    const fallback = sourceSdkSessionId ? this.getLocalCodexThreads().get(sourceSdkSessionId) || null : null;
    const indexedTitle = sourceSdkSessionId ? this.loadLocalThreadTitleIndex().get(sourceSdkSessionId) || '' : '';
    const effectiveLastActiveAt = fallback?.lastActiveAt || record.lastActiveAt;
    const effectiveTitle = fallback?.title || indexedTitle || record.title;
    const messages = this.loadMessages(record.sessionId);
    let latestMessagePreview = '';
    let latestMessageRole = '';
    let latestUserPreview = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const preview = extractPreviewText(msg.content);
      if (!latestMessagePreview && isUsefulConversationPreview(preview)) {
        latestMessagePreview = preview.slice(0, 120);
        latestMessageRole = msg.role;
      }
      if (msg.role === 'user' && isUsefulUserPreview(preview)) {
        latestUserPreview = preview.slice(0, 120);
      }
      if (latestMessagePreview && latestUserPreview) break;
    }
    if (!latestMessagePreview && fallback?.latestMessagePreview) {
      latestMessagePreview = fallback.latestMessagePreview;
      latestMessageRole = fallback.latestMessageRole;
    }
    if (!latestUserPreview && fallback?.latestUserPreview) {
      latestUserPreview = fallback.latestUserPreview;
    }
    return {
      ...record,
      title: effectiveTitle,
      lastActiveAt: effectiveLastActiveAt,
      latestMessagePreview,
      latestMessageRole,
      latestUserPreview,
      lastActiveLabel: formatThreadTimestamp(effectiveLastActiveAt),
      sdkSessionId,
      displayId: sourceSdkSessionId || record.sessionId,
      source: 'managed',
      importable: false,
    };
  }

  private findLatestManagedDialogue(sessionId: string): ThreadDialogue | null {
    const messages = this.loadMessages(sessionId);
    let lastUserIndex = -1;
    let userText = '';

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const text = extractRenderableText(msg.content);
      if (!text || !isUsefulConversationPreview(text)) continue;
      lastUserIndex = i;
      userText = text;
      break;
    }
    if (lastUserIndex === -1) return null;

    for (let i = lastUserIndex + 1; i < messages.length; i += 1) {
      const msg = messages[i];
      const text = extractRenderableText(msg.content);
      if (!text || !isUsefulConversationPreview(text)) continue;
      if (msg.role === 'assistant') {
        return {
          userText,
          assistantText: text,
        };
      }
      if (msg.role === 'user') break;
    }
    return {
      userText,
      assistantText: '',
    };
  }

  private readLocalConversationEvents(sdkSessionId: string): LocalConversationEvent[] {
    const local = this.getLocalCodexThreads().get(sdkSessionId);
    if (!local) return [];

    let raw = '';
    try {
      raw = fs.readFileSync(local.filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = raw.split('\n').filter(Boolean);
    const events: LocalConversationEvent[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        const parsed = JSON.parse(lines[i]) as {
          type?: string;
          payload?: { type?: string; message?: string; phase?: string };
        };
        if (parsed.type !== 'event_msg') continue;
        const eventType = parsed.payload?.type || '';
        if (eventType !== 'user_message' && eventType !== 'agent_message') continue;
        if (eventType === 'agent_message' && parsed.payload?.phase && parsed.payload.phase !== 'final_answer') {
          continue;
        }
        const text = extractRenderableText(parsed.payload?.message || '');
        if (!text || !isUsefulConversationPreview(text) || !isUsefulThreadListPreview(text)) continue;
        if (eventType === 'user_message' && !isUsefulUserPreview(text)) continue;
        events.push({
          role: eventType === 'agent_message' ? 'assistant' : 'user',
          text,
        });
      } catch {
        continue;
      }
    }
    return events;
  }

  private getRecentLocalConversationHistory(
    sdkSessionId: string,
    maxMessages = 12,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.readLocalConversationEvents(sdkSessionId)
      .slice(-maxMessages)
      .map((event) => ({ role: event.role, content: event.text }));
  }

  private findLatestLocalDialogue(sdkSessionId: string): ThreadDialogue | null {
    const events = this.readLocalConversationEvents(sdkSessionId);
    if (events.length === 0) return null;

    let lastUserIndex = -1;
    let userText = '';
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].role !== 'user') continue;
      lastUserIndex = i;
      userText = events[i].text;
      break;
    }
    if (lastUserIndex === -1) return null;
    for (let i = lastUserIndex + 1; i < events.length; i += 1) {
      if (events[i].role === 'assistant') {
        return {
          userText,
          assistantText: events[i].text,
        };
      }
      if (events[i].role === 'user') break;
    }
    return {
      userText,
      assistantText: '',
    };
  }

  private findThreadRecordBySessionId(sessionId: string): ThreadRecord | null {
    for (const record of this.threads.values()) {
      if (record.sessionId === sessionId) {
        return record;
      }
    }
    return null;
  }

  private buildBusyLocalThreadState(record: ThreadRecord): BusyLocalThreadState | null {
    const sdkSessionId = this.getDesktopPrioritySdkSessionId(record);
    if (!sdkSessionId) return null;

    const local = this.getLocalCodexThreads().get(sdkSessionId);
    if (!local) return null;

    const lines = readTailLines(local.filePath, LOCAL_THREAD_ANALYSIS_TAIL_BYTES);
    if (lines.length === 0) return null;

    let lastUserPrompt = '';
    let lastUserTimestampMs = 0;
    let lastUserTimestamp = '';
    let lastTaskCompleteMs = 0;
    let lastTurnAbortedMs = 0;
    let lastActivityMs = 0;
    let lastActivityAt = '';
    let previewText = '';
    let finalText = '';
    let lastRolloutText = '';
    let eventOrder = 0;
    let lastMeaningfulEventOrder = 0;
    let lastTaskCompleteOrder = 0;
    let lastTurnAbortedOrder = 0;
    const tools = new Map<string, ThreadToolState>();

    for (const line of lines) {
      const timestampMs = parseRecordTimestampMs(line);
      if (timestampMs && timestampMs >= lastActivityMs) {
        lastActivityMs = timestampMs;
        lastActivityAt = new Date(timestampMs).toISOString();
      }

      const rawUserMessage = extractRolloutUserMessageText(line);
      if (rawUserMessage && timestampMs) {
        lastUserPrompt = normalizePromptText(rawUserMessage);
        lastUserTimestampMs = timestampMs;
        lastUserTimestamp = new Date(timestampMs).toISOString();
        lastTaskCompleteMs = 0;
        lastTurnAbortedMs = 0;
        previewText = '';
        finalText = '';
        lastRolloutText = '';
        eventOrder = 0;
        lastMeaningfulEventOrder = 0;
        lastTaskCompleteOrder = 0;
        lastTurnAbortedOrder = 0;
        tools.clear();
      }

      if (!lastUserTimestampMs) {
        continue;
      }
      if (timestampMs && timestampMs + 1000 < lastUserTimestampMs) {
        continue;
      }

      let events = [];
      try {
        events = parseCodexRolloutRecord(line);
      } catch {
        continue;
      }
      for (const event of events) {
        if (event.kind !== 'usage') {
          eventOrder += 1;
          lastMeaningfulEventOrder = eventOrder;
        }
        switch (event.kind) {
          case 'tool_use':
            tools.set(event.id, {
              id: event.id,
              name: event.name,
              status: 'running',
              requiresApproval: event.requiresApproval,
            });
            break;

          case 'tool_result': {
            const existing = tools.get(event.id);
            tools.set(event.id, {
              id: event.id,
              name: existing?.name || 'Tool',
              status: event.isError ? 'error' : 'complete',
              requiresApproval: existing?.requiresApproval,
            });
            if (event.interrupted) {
              lastTurnAbortedMs = timestampMs || Date.now();
              lastTurnAbortedOrder = eventOrder;
            }
            break;
          }

          case 'commentary':
            ({ currentText: previewText, lastRolloutText } = appendRolloutPreviewText(
              previewText,
              lastRolloutText,
              event.text,
            ));
            break;

          case 'final_answer':
            finalText = event.text;
            break;

          case 'task_complete':
            lastTaskCompleteMs = timestampMs || Date.now();
            lastTaskCompleteOrder = eventOrder;
            if (event.lastAgentMessage) {
              finalText = event.lastAgentMessage;
            }
            break;

          case 'turn_aborted':
            lastTurnAbortedMs = timestampMs || Date.now();
            lastTurnAbortedOrder = eventOrder;
            break;

          default:
            break;
        }
      }
    }

    if (!lastUserPrompt || !lastUserTimestampMs) {
      return null;
    }
    if (
      lastTaskCompleteMs >= lastUserTimestampMs
      && lastTaskCompleteOrder === lastMeaningfulEventOrder
    ) {
      return null;
    }
    if (
      lastTurnAbortedMs >= lastUserTimestampMs
      && lastTurnAbortedOrder > lastTaskCompleteOrder
      && lastTurnAbortedOrder === lastMeaningfulEventOrder
    ) {
      return null;
    }
    const effectiveLastActivityMs = lastActivityMs || lastUserTimestampMs;
    const runningTools = Array.from(tools.values()).filter((tool) => tool.status === 'running');
    const waitingApprovalOnly = runningTools.length > 0
      && runningTools.every((tool) => tool.requiresApproval);
    if (waitingApprovalOnly && Date.now() - effectiveLastActivityMs > LOCAL_THREAD_WAITING_APPROVAL_IDLE_MS) {
      return null;
    }
    if (Date.now() - effectiveLastActivityMs > LOCAL_THREAD_BUSY_STALE_MS) {
      return null;
    }

    return {
      sdkSessionId,
      filePath: local.filePath,
      prompt: lastUserPrompt,
      turnStartedAt: lastUserTimestamp,
      turnStartedAtMs: lastUserTimestampMs,
      lastActivityAt: lastActivityAt || lastUserTimestamp,
      previewText,
      finalText,
      lastRolloutText,
      tools: Array.from(tools.values()),
    };
  }

  private listImportableLocalThreads(channelType: string, chatId: string): ThreadSummary[] {
    const workdirs = this.getRelevantChatWorkdirs(channelType, chatId);
    const importedSdkIds = new Set<string>();
    for (const thread of this.threads.values()) {
      if (thread.channelType !== channelType || thread.chatId !== chatId) continue;
      const sdkSessionId = this.getThreadSourceSdkSessionId(thread);
      if (sdkSessionId) {
        importedSdkIds.add(sdkSessionId);
      }
    }

    return Array.from(this.getLocalCodexThreads().values())
      .filter((thread) => !importedSdkIds.has(thread.sdkSessionId))
      .filter((thread) => workdirs.size === 0 || workdirs.has(thread.workingDirectory))
      .map((thread) => ({
        id: `local:${thread.sdkSessionId}`,
        channelType,
        chatId,
        sessionId: '',
        title: thread.title,
        workingDirectory: thread.workingDirectory,
        model: thread.model,
        createdAt: thread.lastActiveAt,
        updatedAt: thread.lastActiveAt,
        lastActiveAt: thread.lastActiveAt,
        latestMessagePreview: thread.latestMessagePreview,
        latestMessageRole: thread.latestMessageRole,
        latestUserPreview: thread.latestUserPreview,
        lastActiveLabel: formatThreadTimestamp(thread.lastActiveAt),
        sdkSessionId: thread.sdkSessionId,
        displayId: thread.sdkSessionId,
        source: 'local',
        importable: true,
      }));
  }

  private findManagedThreadBySdkSessionId(
    channelType: string,
    chatId: string,
    sdkSessionId: string,
  ): ThreadRecord | null {
    for (const thread of this.threads.values()) {
      if (thread.channelType !== channelType || thread.chatId !== chatId) continue;
      if (this.getThreadSourceSdkSessionId(thread) === sdkSessionId) {
        return thread;
      }
    }
    return null;
  }

  private upsertThreadRecord(
    channelType: string,
    chatId: string,
    sessionId: string,
    metadata?: { workingDirectory?: string; model?: string; title?: string; touch?: boolean },
  ): ThreadRecord {
    const key = this.threadKey(channelType, chatId, sessionId);
    const session = this.sessions.get(sessionId);
    const timestamp = now();
    const workingDirectory = metadata?.workingDirectory
      || session?.working_directory
      || this.settings.get('default_workdir')
      || '';
    const model = metadata?.model
      || session?.model
      || this.settings.get('default_model')
      || '';
    const existing = this.threads.get(key);
    const title = metadata?.title?.trim()
      || existing?.title
      || this.defaultThreadTitle(sessionId, workingDirectory);

    const record: ThreadRecord = existing
      ? {
          ...existing,
          title,
          workingDirectory,
          model,
          updatedAt: timestamp,
          lastActiveAt: metadata?.touch === false ? existing.lastActiveAt : timestamp,
        }
      : {
          id: uuid(),
          channelType,
          chatId,
          sessionId,
          title,
          workingDirectory,
          model,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastActiveAt: timestamp,
        };

    this.threads.set(key, record);
    this.persistThreads();
    return record;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: (data as { sdkSessionId?: string }).sdkSessionId ?? '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.upsertThreadRecord(data.channelType, data.chatId, data.codepilotSessionId, {
        workingDirectory: data.workingDirectory,
        model: data.model,
      });
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: (data as { sdkSessionId?: string }).sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.upsertThreadRecord(data.channelType, data.chatId, data.codepilotSessionId, {
      workingDirectory: data.workingDirectory,
      model: data.model,
    });
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        const updated = { ...b, ...updates, updatedAt: now() };
        this.bindings.set(key, updated);
        this.upsertThreadRecord(updated.channelType, updated.chatId, updated.codepilotSessionId, {
          workingDirectory: updated.workingDirectory,
          model: updated.model,
          touch: false,
        });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('default_workdir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content: sanitizeStoredMessage(role, content) });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  listChatThreads(channelType: string, chatId: string): ThreadSummary[] {
    const managed = Array.from(this.threads.values())
      .filter((thread) => thread.channelType === channelType && thread.chatId === chatId)
      .map((thread) => this.buildManagedThreadSummary(thread));
    const local = this.listImportableLocalThreads(channelType, chatId);

    return [...managed, ...local]
      .sort((a, b) => {
        if (a.lastActiveAt === b.lastActiveAt) {
          return b.createdAt.localeCompare(a.createdAt);
        }
        return b.lastActiveAt.localeCompare(a.lastActiveAt);
      });
  }

  findChatThread(channelType: string, chatId: string, identifier: string): ThreadSummary | null {
    const threads = this.listChatThreads(channelType, chatId);
    const normalized = identifier.trim();
    if (!normalized) return null;

    if (/^\d+$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10) - 1;
      return threads[index] ?? null;
    }

    const exact = threads.find((thread) =>
      thread.sessionId === normalized
      || thread.sdkSessionId === normalized
      || thread.displayId === normalized,
    );
    if (exact) return exact;

    const lower = normalized.toLowerCase();
    const exactTitle = threads.find((thread) => normalizeWhitespace(thread.title).toLowerCase() === lower);
    if (exactTitle) return exactTitle;

    const titleMatches = threads.filter((thread) =>
      normalizeWhitespace(thread.title).toLowerCase().includes(lower),
    );
    if (titleMatches.length === 1) return titleMatches[0];

    const matches = threads.filter((thread) =>
      (thread.sessionId && thread.sessionId.toLowerCase().startsWith(lower))
      || (thread.sdkSessionId && thread.sdkSessionId.toLowerCase().startsWith(lower))
      || (thread.displayId && thread.displayId.toLowerCase().startsWith(lower)),
    );
    if (matches.length === 1) return matches[0];

    return null;
  }

  importChatThread(channelType: string, chatId: string, sdkSessionId: string): ThreadSummary | null {
    const existing = this.findManagedThreadBySdkSessionId(channelType, chatId, sdkSessionId);
    if (existing) {
      return this.buildManagedThreadSummary(existing);
    }

    const local = this.getLocalCodexThreads().get(sdkSessionId);
    if (!local) return null;

    const session = this.createSession(
      `Bridge: ${local.title}`,
      local.model,
      undefined,
      local.workingDirectory,
      'code',
    );
    for (const message of this.getRecentLocalConversationHistory(sdkSessionId)) {
      this.addMessage(session.id, message.role, message.content);
    }
    this.upsertThreadRecord(channelType, chatId, session.id, {
      title: local.title,
      workingDirectory: local.workingDirectory,
      model: local.model,
      touch: false,
    });

    const key = this.threadKey(channelType, chatId, session.id);
    const record = this.threads.get(key);
    if (record) {
      record.importedSdkSessionId = sdkSessionId;
      this.threads.set(key, record);
      this.persistThreads();
    }
    return record ? this.buildManagedThreadSummary(record) : null;
  }

  touchChatThread(
    channelType: string,
    chatId: string,
    sessionId: string,
    metadata?: { workingDirectory?: string; model?: string; title?: string; touch?: boolean },
  ): void {
    this.upsertThreadRecord(channelType, chatId, sessionId, {
      ...metadata,
      touch: metadata?.touch ?? true,
    });
  }

  describeChatThread(channelType: string, chatId: string, sessionId: string): ThreadSummary | null {
    const record = this.threads.get(this.threadKey(channelType, chatId, sessionId));
    if (!record) return null;
    return this.buildManagedThreadSummary(record);
  }

  getThreadLatestDialogue(sessionId: string): ThreadDialogue | null {
    const record = this.findThreadRecordBySessionId(sessionId);
    const sdkSessionId = record ? this.getDesktopPrioritySdkSessionId(record) : this.getSessionSdkSessionId(sessionId);
    if (sdkSessionId) {
      const local = this.findLatestLocalDialogue(sdkSessionId);
      if (local?.assistantText || local?.userText) {
        return local;
      }
    }

    const managed = this.findLatestManagedDialogue(sessionId);
    if (managed?.assistantText || managed?.userText) {
      return managed;
    }
    return null;
  }

  getBusyLocalThreadState(sessionId: string): {
    sdkSessionId: string;
    prompt: string;
    turnStartedAt: string;
    lastActivityAt: string;
    previewText: string;
    finalText: string;
    tools: ThreadToolState[];
  } | null {
    const record = this.findThreadRecordBySessionId(sessionId);
    if (!record) return null;
    const state = this.buildBusyLocalThreadState(record);
    if (!state) return null;
    return {
      sdkSessionId: state.sdkSessionId,
      prompt: state.prompt,
      turnStartedAt: state.turnStartedAt,
      lastActivityAt: state.lastActivityAt,
      previewText: state.previewText,
      finalText: state.finalText,
      tools: state.tools.map((tool) => ({ ...tool })),
    };
  }

  async followBusyLocalThread(
    sessionId: string,
    options?: {
      abortSignal?: AbortSignal;
      onText?: (fullText: string) => void;
      onTools?: (tools: ThreadToolState[]) => void;
    },
  ): Promise<{ busy: boolean; completed: boolean; finalText: string }> {
    const record = this.findThreadRecordBySessionId(sessionId);
    if (!record) {
      return { busy: false, completed: false, finalText: '' };
    }
    const state = this.buildBusyLocalThreadState(record);
    if (!state) {
      return { busy: false, completed: false, finalText: '' };
    }

    let currentText = state.previewText;
    let finalText = state.finalText || '';
    let lastRolloutText = state.lastRolloutText;
    let completed = false;
    let interrupted = false;
    const tools = new Map(state.tools.map((tool) => [tool.id, { ...tool }]));
    options?.onText?.(currentText);
    if (tools.size > 0) {
      options?.onTools?.(Array.from(tools.values()));
    }

    let startPosition = 0;
    try {
      startPosition = fs.statSync(state.filePath).size;
    } catch {
      return { busy: true, completed: false, finalText: finalText || currentText };
    }

    const tailer = new JsonlTailReader(state.filePath, startPosition);
    let lastActivityMs = state.lastActivityAt ? Date.parse(state.lastActivityAt) : Date.now();

    while (!options?.abortSignal?.aborted) {
      let sawNewData = false;
      let lines: string[] = [];
      try {
        lines = tailer.readAvailableLines();
      } catch {
        break;
      }
      if (lines.length > 0) {
        sawNewData = true;
      }

      for (const line of lines) {
        const timestampMs = parseRecordTimestampMs(line);
        if (timestampMs && timestampMs + 1000 < state.turnStartedAtMs) {
          continue;
        }

        const rawUserMessage = extractRolloutUserMessageText(line);
        if (
          rawUserMessage &&
          timestampMs &&
          timestampMs >= state.turnStartedAtMs &&
          normalizePromptText(rawUserMessage) !== state.prompt
        ) {
          completed = true;
          break;
        }

        if (timestampMs) {
          lastActivityMs = timestampMs;
        }

        let events = [];
        try {
          events = parseCodexRolloutRecord(line);
        } catch {
          continue;
        }
        for (const event of events) {
          switch (event.kind) {
            case 'tool_use':
              tools.set(event.id, {
                id: event.id,
                name: event.name,
                status: 'running',
                requiresApproval: event.requiresApproval,
              });
              options?.onTools?.(Array.from(tools.values()));
              break;

            case 'tool_result': {
              const existing = tools.get(event.id);
              tools.set(event.id, {
                id: event.id,
                name: existing?.name || 'Tool',
                status: event.isError ? 'error' : 'complete',
                requiresApproval: existing?.requiresApproval,
              });
              options?.onTools?.(Array.from(tools.values()));
              break;
            }

            case 'commentary':
              {
                const next = appendRolloutPreviewText(currentText, lastRolloutText, event.text);
                if (next.currentText !== currentText) {
                  currentText = next.currentText;
                  lastRolloutText = next.lastRolloutText;
                  options?.onText?.(currentText);
                } else {
                  lastRolloutText = next.lastRolloutText;
                }
              }
              break;

            case 'final_answer':
              finalText = event.text;
              break;

            case 'task_complete':
              if (event.lastAgentMessage) {
                finalText = event.lastAgentMessage;
              }
              completed = true;
              break;

            case 'turn_aborted':
              interrupted = true;
              break;

            default:
              break;
          }
        }

        if (completed || interrupted) {
          break;
        }
      }

      if (completed || interrupted) {
        break;
      }
      if (!sawNewData && Date.now() - lastActivityMs > LOCAL_THREAD_BUSY_STALE_MS) {
        break;
      }

      await sleep(LOCAL_THREAD_FOLLOW_INTERVAL_MS);
    }

    return {
      busy: true,
      completed,
      finalText: finalText || currentText,
    };
  }

  syncImportedThreadFromLocalSource(sessionId: string): ThreadDialogue | null {
    const record = this.findThreadRecordBySessionId(sessionId);
    if (!record) return null;

    const sdkSessionId = this.getDesktopPrioritySdkSessionId(record);
    if (!sdkSessionId) return null;

    const latestLocalDialogue = this.findLatestLocalDialogue(sdkSessionId);
    if (!latestLocalDialogue) return null;

    const latestManagedDialogue = this.findLatestManagedDialogue(sessionId);
    const managedUser = normalizePromptText(latestManagedDialogue?.userText || '');
    const managedAssistant = normalizePromptText(latestManagedDialogue?.assistantText || '');
    const localUser = normalizePromptText(latestLocalDialogue.userText || '');
    const localAssistant = normalizePromptText(latestLocalDialogue.assistantText || '');

    if (!latestManagedDialogue || managedUser !== localUser) {
      if (latestLocalDialogue.userText) {
        this.addMessage(sessionId, 'user', latestLocalDialogue.userText);
      }
    }
    if (latestLocalDialogue.assistantText && managedAssistant !== localAssistant) {
      this.addMessage(sessionId, 'assistant', latestLocalDialogue.assistantText);
    }

    return latestLocalDialogue;
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
