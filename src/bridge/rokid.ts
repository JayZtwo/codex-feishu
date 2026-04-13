import crypto from 'node:crypto';
import http from 'node:http';

import type { Config } from '../config.js';
import type {
  BridgeAdapter,
  FileAttachment,
  InboundMessage,
  SendResult,
  ThreadSummary,
  ToolProgress,
} from './contracts.js';
import { htmlToMarkdown, renderThreadListText } from './format.js';

type InboundHandler = (message: InboundMessage) => Promise<void>;

type ActiveSseState = {
  chatId: string;
  messageId: string;
  startedAt: number;
  res: http.ServerResponse;
  text: string;
  toolsKey: string;
  closed: boolean;
};

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/rokid/agent';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function findStringByKeys(value: unknown, keys: string[], depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findStringByKeys(value[index], keys, depth + 1);
      if (found) return found;
    }
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = textFromUnknown(record[key]);
    if (direct) return direct;
  }

  for (const nested of Object.values(record)) {
    const found = findStringByKeys(nested, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function extractPrompt(payload: unknown, url: URL): string {
  for (const key of ['q', 'query', 'prompt', 'text', 'message', 'content']) {
    const value = url.searchParams.get(key);
    if (value?.trim()) return value.trim();
  }

  const direct = findStringByKeys(payload, [
    'query',
    'prompt',
    'text',
    'utterance',
    'question',
    'user_input',
    'userInput',
    'content',
    'message',
  ]);
  if (direct) return direct;

  if (payload && typeof payload === 'object') {
    const messages = (payload as Record<string, unknown>).messages;
    if (Array.isArray(messages)) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index] as Record<string, unknown> | undefined;
        const content = item?.content;
        if (typeof content === 'string' && content.trim()) return content.trim();
        if (Array.isArray(content)) {
          const combined = content.map((part) => findStringByKeys(part, ['text', 'content'])).filter(Boolean).join('\n');
          if (combined.trim()) return combined.trim();
        }
      }
    }
  }

  return '';
}

function extractFirstId(payload: unknown, url: URL, keys: string[]): string {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value?.trim()) return value.trim();
  }
  return findStringByKeys(payload, keys);
}

function readAuthorizationToken(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  const directHeader = req.headers['x-codex-feishu-token']
    || req.headers['x-rokid-token']
    || req.headers['x-lingzhu-token'];
  if (typeof directHeader === 'string') return directHeader.trim();
  if (Array.isArray(directHeader)) return directHeader[0]?.trim() || '';
  return url.searchParams.get('token')?.trim() || '';
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class RokidAdapter implements BridgeAdapter {
  readonly channelType = 'rokid' as const;
  readonly displayName = 'Rokid';

  private server: http.Server | null = null;
  private running = false;
  private handler: InboundHandler | null = null;
  private readonly active = new Map<string, ActiveSseState>();
  private readonly endpointPath: string;

  constructor(private readonly config: Config) {
    this.endpointPath = normalizePath(config.rokidPath);
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.running) return;
    if (!this.config.rokidSecret) {
      throw new Error('Missing CODEX_FEISHU_ROKID_SECRET for Rokid/Lingzhu HTTP endpoint');
    }
    this.handler = handler;
    this.server = http.createServer((req, res) => {
      void this.route(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.rokidPort, this.config.rokidHost, () => resolve());
    });
    this.running = true;
    console.log(`[rokid] Adapter started at http://${this.config.rokidHost}:${this.config.rokidPort}${this.endpointPath}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const state of this.active.values()) {
      this.closeState(state, 'interrupted', state.text || 'Interrupted');
    }
    this.active.clear();
    const server = this.server;
    this.server = null;
    this.handler = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendText(chatId: string, text: string, _replyToMessageId?: string): Promise<SendResult> {
    const state = this.active.get(chatId);
    if (!state) return { ok: false, error: 'Rokid stream not found' };
    this.writeEvent(state, 'message', {
      type: 'text',
      role: 'assistant',
      content: text,
      text,
    });
    state.text = text;
    return { ok: true, messageId: state.messageId };
  }

  async sendHtml(chatId: string, html: string, replyToMessageId?: string): Promise<SendResult> {
    return this.sendMarkdown(chatId, htmlToMarkdown(html), replyToMessageId);
  }

  async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<SendResult> {
    return this.sendText(chatId, markdown, replyToMessageId);
  }

  async sendPermissionRequest(
    chatId: string,
    body: string,
    permissionId: string,
    _replyToMessageId?: string,
  ): Promise<SendResult> {
    const state = this.active.get(chatId);
    if (!state) return { ok: false, error: 'Rokid stream not found' };
    this.writeEvent(state, 'permission_request', {
      type: 'permission_request',
      permission_id: permissionId,
      content: body,
      message: '需要在 Codex 桌面端或 Feishu 审批后继续。',
    });
    return { ok: true, messageId: state.messageId };
  }

  async sendThreadPicker(
    chatId: string,
    threads: ThreadSummary[],
    currentSessionId: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    return this.sendText(chatId, renderThreadListText(threads, currentSessionId), replyToMessageId);
  }

  async sendCommandReply(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    await this.sendHtml(chatId, text, replyToMessageId);
  }

  beginResponse(chatId: string, _replyToMessageId?: string): void {
    const state = this.active.get(chatId);
    if (!state) return;
    this.writeEvent(state, 'status', {
      type: 'status',
      status: 'thinking',
    });
  }

  updateResponse(chatId: string, fullText: string, tools: ToolProgress[]): void {
    const state = this.active.get(chatId);
    if (!state || state.closed) return;

    const delta = fullText.startsWith(state.text) ? fullText.slice(state.text.length) : fullText;
    if (delta) {
      this.writeEvent(state, 'message', {
        type: 'text_delta',
        role: 'assistant',
        delta,
        content: delta,
        text: fullText,
      });
      state.text = fullText;
    }

    const toolsKey = tools.map((tool) => `${tool.name}:${tool.status}`).join('|');
    if (toolsKey && toolsKey !== state.toolsKey) {
      this.writeEvent(state, 'tools', {
        type: 'tools',
        tools,
      });
      state.toolsKey = toolsKey;
    }
  }

  async finalizeResponse(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    finalText: string,
    _replyToMessageId?: string,
  ): Promise<boolean> {
    const state = this.active.get(chatId);
    if (!state) return false;
    this.closeState(state, status, finalText);
    this.active.delete(chatId);
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${this.config.rokidHost}:${this.config.rokidPort}`}`);
    this.setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === `${this.endpointPath}/health`)) {
      this.sendJson(res, 200, { ok: true, channel: 'rokid', path: this.endpointPath });
      return;
    }

    if (url.pathname !== this.endpointPath || !['GET', 'POST'].includes(req.method || '')) {
      this.sendJson(res, 404, { error: 'not_found', path: this.endpointPath });
      return;
    }

    if (readAuthorizationToken(req, url) !== this.config.rokidSecret) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let raw = '';
    try {
      raw = req.method === 'POST' ? await readRequestBody(req) : '';
    } catch (error) {
      this.sendJson(res, 413, { error: error instanceof Error ? error.message : 'Request body is too large' });
      return;
    }

    const payload = parseJsonBody(raw);
    const prompt = extractPrompt(payload, url);
    if (!prompt) {
      this.sendJson(res, 400, { error: 'missing_prompt', expected: 'query, prompt, text, message, content, or messages[]' });
      return;
    }

    const userId = extractFirstId(payload, url, ['user_id', 'userId', 'open_id', 'uid']) || 'rokid-user';
    const deviceId = extractFirstId(payload, url, ['device_id', 'deviceId', 'sn']) || '';
    const sessionId = extractFirstId(payload, url, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'chat_id', 'chatId'])
      || deviceId
      || userId
      || sha(`${req.socket.remoteAddress || 'unknown'}:${userId}`).slice(0, 16);
    const messageId = extractFirstId(payload, url, ['message_id', 'messageId', 'request_id', 'requestId', 'event_id', 'eventId', 'id'])
      || sha(`${sessionId}:${prompt}:${raw || url.search}`).slice(0, 32);

    if (!this.isAuthorized(userId, sessionId)) {
      this.sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    const abortController = new AbortController();
    const state: ActiveSseState = {
      chatId: sessionId,
      messageId,
      startedAt: Date.now(),
      res,
      text: '',
      toolsKey: '',
      closed: false,
    };
    this.active.set(sessionId, state);

    res.on('close', () => {
      if (!state.closed) {
        abortController.abort();
        state.closed = true;
        this.active.delete(sessionId);
      }
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.writeEvent(state, 'ready', {
      type: 'ready',
      channel: 'rokid',
      session_id: sessionId,
      message_id: messageId,
    });

    const inbound: InboundMessage = {
      messageId,
      address: {
        channelType: 'rokid',
        chatId: sessionId,
        userId,
        displayName: deviceId || userId,
      },
      text: prompt,
      timestamp: Date.now(),
      raw: payload,
      attachments: this.extractAttachments(payload),
      abortSignal: abortController.signal,
    };

    try {
      await this.handler?.(inbound);
      if (!state.closed) {
        this.closeState(state, 'completed', state.text || 'Done.');
        this.active.delete(sessionId);
      }
    } catch (error) {
      if (!state.closed) {
        this.closeState(state, 'error', error instanceof Error ? error.message : String(error));
        this.active.delete(sessionId);
      }
    }
  }

  private extractAttachments(payload: unknown): FileAttachment[] | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const files = (payload as Record<string, unknown>).files || (payload as Record<string, unknown>).attachments;
    if (!Array.isArray(files)) return undefined;
    const attachments = files.flatMap((file, index) => {
      if (!file || typeof file !== 'object') return [];
      const record = file as Record<string, unknown>;
      const data = textFromUnknown(record.data || record.base64);
      if (!data) return [];
      return [{
        id: textFromUnknown(record.id) || `rokid-file-${index}`,
        name: textFromUnknown(record.name) || `rokid-file-${index}`,
        type: textFromUnknown(record.type || record.mime) || 'application/octet-stream',
        size: Number(record.size) || Buffer.byteLength(data, 'base64'),
        data,
      }];
    });
    return attachments.length > 0 ? attachments : undefined;
  }

  private isAuthorized(userId: string, chatId: string): boolean {
    const allowed = this.config.rokidAllowedUsers || [];
    if (allowed.length === 0) return true;
    return allowed.includes(userId) || allowed.includes(chatId);
  }

  private setCors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-codex-feishu-token,x-rokid-token,x-lingzhu-token');
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private writeEvent(state: ActiveSseState, event: string, data: unknown): void {
    if (state.closed || state.res.writableEnded) return;
    state.res.write(`event: ${event}\n`);
    state.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private closeState(
    state: ActiveSseState,
    status: 'completed' | 'interrupted' | 'error',
    finalText: string,
  ): void {
    if (state.closed || state.res.writableEnded) return;
    if (finalText && finalText !== state.text) {
      this.writeEvent(state, 'message', {
        type: 'text',
        role: 'assistant',
        content: finalText,
        text: finalText,
      });
      state.text = finalText;
    }
    this.writeEvent(state, 'done', {
      type: 'done',
      status,
      content: finalText,
      elapsed_ms: Date.now() - state.startedAt,
    });
    state.res.end();
    state.closed = true;
  }
}
