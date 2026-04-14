import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';

import type { Config } from '../config.js';
import type { JsonFileStore } from '../store.js';
import type {
  BridgeAdapter,
  FileAttachment,
  InboundMessage,
  SendResult,
  ThreadSummary,
  ToolProgress,
} from './contracts.js';
import {
  buildMarkdownCard,
  buildPermissionCard,
  buildPostContent,
  buildStreamingCard,
  buildThreadPickerCard,
  extractLocalFileReferences,
  formatElapsed,
  hasComplexMarkdown,
  htmlToMarkdown,
  isImagePath,
  preprocessMarkdown,
  renderThreadListText,
} from './format.js';

type InboundHandler = (message: InboundMessage) => Promise<void>;

type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

type ActiveCardState = {
  messageId: string;
  startedAt: number;
  text: string;
  tools: ToolProgress[];
  thinking: boolean;
  lastSentKey: string;
  lastSentTextLength: number;
  lastUpdateAt: number;
  backoffUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushInProgress: boolean;
  pendingFlush: boolean;
};

const DEDUP_MAX = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_OUTBOUND_FILE_SIZE = 30 * 1024 * 1024;
const TYPING_EMOJI = 'Typing';
const CARD_UPDATE_INTERVAL_MS = 1200;
const CARD_MIN_DELTA = 80;
const CARD_RATE_LIMIT_BACKOFF_MS = 3000;
const FEISHU_CARD_RATE_LIMIT_CODES = new Set([230020, 99991400]);

const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

function normalizeCallbackText(rawText: string): string {
  return rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function buildCardUpdateKey(text: string, tools: ToolProgress[], thinking: boolean): string {
  return JSON.stringify({
    thinking,
    textLength: text.length,
    textTail: text.slice(-160),
    tools: tools.map((tool) => `${tool.name}:${tool.status}`).join('|'),
  });
}

export class FeishuAdapter implements BridgeAdapter {
  readonly channelType = 'feishu' as const;
  readonly displayName = 'Feishu';

  private readonly seenMessageIds = new Map<string, true>();
  private readonly typingReactions = new Map<string, string>();
  private readonly lastIncomingMessageId = new Map<string, string>();
  private readonly activeCards = new Map<string, ActiveCardState>();
  private readonly cardCreates = new Map<string, Promise<boolean>>();
  private readonly botIds = new Set<string>();
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private running = false;
  private handler: InboundHandler | null = null;
  private botOpenId: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly store: JsonFileStore,
  ) {}

  async start(handler: InboundHandler): Promise<void> {
    if (this.running) return;
    if (!this.config.feishuAppId || !this.config.feishuAppSecret) {
      throw new Error('Missing Feishu app credentials');
    }

    const domain = this.config.feishuDomain === 'https://open.larksuite.com'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    this.handler = handler;
    this.restClient = new lark.Client({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      domain,
    });
    await this.resolveBotIdentity(domain);

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.processIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.processCardAction(data as Record<string, unknown>);
      }) as any,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      domain,
    });

    const wsClientAny = this.wsClient as unknown as {
      handleEventData?: (data: Record<string, unknown>) => unknown;
    };
    if (typeof wsClientAny.handleEventData === 'function') {
      const original = wsClientAny.handleEventData.bind(this.wsClient);
      wsClientAny.handleEventData = (data: Record<string, unknown>) => {
        const headers = Array.isArray(data.headers) ? data.headers as Array<{ key?: string; value?: string }> : [];
        const typeHeader = headers.find((entry) => entry.key === 'type');
        if (typeHeader?.value === 'card') {
          const patched = {
            ...data,
            headers: headers.map((entry) => (
              entry.key === 'type' ? { ...entry, value: 'event' } : entry
            )),
          };
          return original(patched);
        }
        return original(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.running = true;
    console.log('[feishu] Adapter started', this.botOpenId ? `(bot: ${this.botOpenId})` : '');
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const state of this.activeCards.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.activeCards.clear();
    this.cardCreates.clear();
    this.typingReactions.clear();
    this.lastIncomingMessageId.clear();
    this.seenMessageIds.clear();
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
    this.restClient = null;
    this.handler = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    try {
      const res = replyToMessageId
        ? await this.restClient.im.message.reply({
            path: { message_id: replyToMessageId },
            data: { msg_type: 'text', content: JSON.stringify({ text }) },
          })
        : await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
          });
      const messageId = res?.data?.message_id;
      return messageId ? { ok: true, messageId } : { ok: false, error: res?.msg || 'send failed' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'send failed' };
    }
  }

  async sendHtml(chatId: string, html: string, replyToMessageId?: string): Promise<SendResult> {
    return this.sendMarkdown(chatId, htmlToMarkdown(html), replyToMessageId);
  }

  async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };

    const prepared = preprocessMarkdown(markdown);
    const { text, filePaths } = extractLocalFileReferences(prepared);
    let lastResult: SendResult = { ok: false, error: 'empty message' };

    if (text.trim()) {
      lastResult = hasComplexMarkdown(text)
        ? await this.sendInteractiveCard(chatId, buildMarkdownCard(text), replyToMessageId)
        : await this.sendPost(chatId, text, replyToMessageId);
    }

    for (const filePath of filePaths) {
      const attachmentResult = await this.sendLocalAttachment(chatId, filePath);
      if (attachmentResult.ok) {
        lastResult = attachmentResult;
      }
    }

    return lastResult;
  }

  async sendPermissionRequest(chatId: string, body: string, permissionId: string, replyToMessageId?: string): Promise<SendResult> {
    const cardJson = buildPermissionCard(body, permissionId);
    const result = await this.sendInteractiveCard(chatId, cardJson, replyToMessageId);
    if (result.ok) return result;
    return this.sendText(
      chatId,
      `${body}\n\nReply:\n1 - Allow\n2 - Allow Session\n3 - Deny\n\nOr use /perm allow|allow_session|deny ${permissionId}`,
      replyToMessageId,
    );
  }

  async sendThreadPicker(
    chatId: string,
    threads: ThreadSummary[],
    currentSessionId: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const cardJson = buildThreadPickerCard(threads, currentSessionId);
    const result = await this.sendInteractiveCard(chatId, cardJson, replyToMessageId);
    if (result.ok) return result;
    return this.sendText(chatId, renderThreadListText(threads, currentSessionId), replyToMessageId);
  }

  beginResponse(chatId: string, replyToMessageId?: string): void {
    void this.addTypingReaction(chatId);
    void this.ensureStreamingCard(chatId, replyToMessageId);
  }

  updateResponse(chatId: string, fullText: string, tools: ToolProgress[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.text = fullText;
    state.tools = tools;
    if (fullText.trim()) state.thinking = false;
    this.scheduleCardUpdate(chatId);
  }

  async finalizeResponse(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    finalText: string,
    replyToMessageId?: string,
  ): Promise<boolean> {
    await this.removeTypingReaction(chatId);

    const pending = this.cardCreates.get(chatId);
    if (pending) {
      try { await pending; } catch { /* ignore */ }
    }

    const state = this.activeCards.get(chatId);
    if (!this.restClient || !state) {
      if (finalText) {
        await this.sendMarkdown(chatId, finalText, replyToMessageId);
        return true;
      }
      return false;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    try {
      const statusLabel = status === 'completed'
        ? '✅ Completed'
        : status === 'error'
          ? '❌ Error'
          : '⚠️ Interrupted';
      const { text, filePaths } = extractLocalFileReferences(finalText);
      await this.restClient.im.message.patch({
        path: { message_id: state.messageId },
        data: {
          content: buildStreamingCard(text, state.tools, {
            status: statusLabel,
            elapsed: formatElapsed(state.startedAt),
          }),
        },
      });

      for (const filePath of filePaths) {
        await this.sendLocalAttachment(chatId, filePath);
      }

      this.activeCards.delete(chatId);
      return true;
    } catch (error) {
      console.warn('[feishu] finalize response failed:', error instanceof Error ? error.message : error);
      this.activeCards.delete(chatId);
      if (finalText) {
        await this.sendMarkdown(chatId, finalText, replyToMessageId);
        return true;
      }
      return false;
    }
  }

  async sendCommandReply(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    await this.sendHtml(chatId, text, replyToMessageId);
  }

  private async sendInteractiveCard(chatId: string, content: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    try {
      const res = replyToMessageId
        ? await this.restClient.im.message.reply({
            path: { message_id: replyToMessageId },
            data: { msg_type: 'interactive', content },
          })
        : await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content },
          });
      const messageId = res?.data?.message_id;
      if (messageId) {
        return { ok: true, messageId };
      }
      const error = res?.msg || 'send failed';
      console.warn('[feishu] interactive card send failed:', error);
      return { ok: false, error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'send failed';
      console.warn('[feishu] interactive card send failed:', message);
      return { ok: false, error: message };
    }
  }

  private async sendPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    const content = buildPostContent(text);
    try {
      const res = replyToMessageId
        ? await this.restClient.im.message.reply({
            path: { message_id: replyToMessageId },
            data: { msg_type: 'post', content },
          })
        : await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'post', content },
          });
      const messageId = res?.data?.message_id;
      if (messageId) {
        return { ok: true, messageId };
      }
    } catch (error) {
      console.warn('[feishu] post send failed:', error instanceof Error ? error.message : error);
    }
    return this.sendText(chatId, text, replyToMessageId);
  }

  private async ensureStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return false;
    const existing = this.cardCreates.get(chatId);
    if (existing) return existing;

    const task = (async () => {
      try {
        const result = await this.sendInteractiveCard(
          chatId,
          buildStreamingCard('', [], { thinking: true }),
          replyToMessageId,
        );
        if (!result.ok || !result.messageId) {
          return false;
        }
        this.activeCards.set(chatId, {
          messageId: result.messageId,
          startedAt: Date.now(),
          text: '',
          tools: [],
          thinking: true,
          lastSentKey: '',
          lastSentTextLength: 0,
          lastUpdateAt: 0,
          backoffUntil: 0,
          timer: null,
          flushInProgress: false,
          pendingFlush: false,
        });
        return true;
      } finally {
        this.cardCreates.delete(chatId);
      }
    })();

    this.cardCreates.set(chatId, task);
    return task;
  }

  private scheduleCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;

    const key = buildCardUpdateKey(state.text, state.tools, state.thinking);
    const delta = Math.max(0, state.text.length - state.lastSentTextLength);
    const elapsed = Date.now() - state.lastUpdateAt;

    if (key === state.lastSentKey) return;

    if (state.flushInProgress) {
      state.pendingFlush = true;
      return;
    }

    if (state.lastUpdateAt > 0 && delta < CARD_MIN_DELTA && !state.tools.some((tool) => tool.status === 'running')) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          void this.flushCardUpdate(chatId);
        }, CARD_UPDATE_INTERVAL_MS);
      }
      return;
    }

    if (state.lastUpdateAt > 0 && elapsed < CARD_UPDATE_INTERVAL_MS) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          void this.flushCardUpdate(chatId);
        }, CARD_UPDATE_INTERVAL_MS - elapsed);
      }
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    void this.flushCardUpdate(chatId);
  }

  private async flushCardUpdate(chatId: string): Promise<void> {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    const now = Date.now();
    if (state.backoffUntil > now) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          void this.flushCardUpdate(chatId);
        }, state.backoffUntil - now);
      }
      return;
    }

    if (state.flushInProgress) {
      state.pendingFlush = true;
      return;
    }

    const text = state.text;
    const tools = state.tools;
    const thinking = state.thinking;
    const key = buildCardUpdateKey(text, tools, thinking);
    if (key === state.lastSentKey) return;

    state.flushInProgress = true;
    try {
      await this.restClient.im.message.patch({
        path: { message_id: state.messageId },
        data: { content: buildStreamingCard(text, tools, { thinking }) },
      });
      state.lastSentKey = key;
      state.lastSentTextLength = text.length;
      state.lastUpdateAt = now;
      state.backoffUntil = 0;
    } catch (error) {
      const rawCode = (error as { code?: number | string; response?: { data?: { code?: number | string } } })?.code
        ?? (error as { response?: { data?: { code?: number | string } } })?.response?.data?.code;
      const code = typeof rawCode === 'string' ? Number(rawCode) : rawCode;
      if (typeof code === 'number' && FEISHU_CARD_RATE_LIMIT_CODES.has(code)) {
        state.backoffUntil = Date.now() + CARD_RATE_LIMIT_BACKOFF_MS;
        state.pendingFlush = true;
      }
      console.warn('[feishu] card update failed:', error instanceof Error ? error.message : error);
    } finally {
      state.flushInProgress = false;
      if (state.pendingFlush && this.activeCards.get(chatId) === state) {
        state.pendingFlush = false;
        this.scheduleCardUpdate(chatId);
      }
    }
  }

  private async addTypingReaction(chatId: string): Promise<void> {
    if (!this.restClient) return;
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!messageId) return;
    try {
      const res = await this.restClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: TYPING_EMOJI } },
      });
      const reactionId = (res as { data?: { reaction_id?: string } })?.data?.reaction_id;
      if (reactionId) this.typingReactions.set(chatId, reactionId);
    } catch {
      // non-critical
    }
  }

  private async removeTypingReaction(chatId: string): Promise<void> {
    if (!this.restClient) return;
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId) return;
    this.typingReactions.delete(chatId);
    try {
      await this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // ignore
    }
  }

  private async processCardAction(payload: Record<string, unknown>): Promise<{ toast: { type: 'info'; content: string } }> {
    const callbackData = this.readCardCallbackData(payload);
    const chatId = this.readCardChatId(payload);
    if (!callbackData || !chatId) {
      return { toast: { type: 'info', content: '已收到' } };
    }

    const inbound: InboundMessage = {
      messageId: this.readCardMessageId(payload) || `card-${Date.now()}`,
      address: {
        channelType: 'feishu',
        chatId,
        userId: this.readCardUserId(payload) || undefined,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId: this.readCardMessageId(payload) || undefined,
      raw: payload,
    };

    await this.dispatch(inbound);
    return { toast: { type: 'info', content: '已收到，正在处理...' } };
  }

  private readCardCallbackData(payload: Record<string, unknown>): string {
    const action = payload.action as { value?: { callback_data?: string } } | undefined;
    return action?.value?.callback_data || '';
  }

  private readCardChatId(payload: Record<string, unknown>): string {
    const context = payload.context as { open_chat_id?: string } | undefined;
    return context?.open_chat_id || '';
  }

  private readCardMessageId(payload: Record<string, unknown>): string {
    const context = payload.context as { open_message_id?: string } | undefined;
    return context?.open_message_id || '';
  }

  private readCardUserId(payload: Record<string, unknown>): string {
    const operator = payload.operator as { open_id?: string } | undefined;
    return operator?.open_id || '';
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    if (!this.handler) return;
    const message = data.message;
    const sender = data.sender;

    if (sender.sender_type === 'bot') return;
    if (this.seenMessageIds.has(message.message_id)) return;
    this.addDedup(message.message_id);

    const chatId = message.chat_id;
    const userId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || '';
    if (!this.isAuthorized(userId, chatId)) return;

    if (message.chat_type === 'group' && !this.isBotMentioned(message.mentions)) {
      return;
    }

    this.lastIncomingMessageId.set(chatId, message.message_id);

    let text = '';
    const attachments: FileAttachment[] = [];

    if (message.message_type === 'text') {
      text = this.parseTextContent(message.content);
    } else if (message.message_type === 'post') {
      const parsed = this.parsePostContent(message.content);
      text = parsed.extractedText;
      for (const imageKey of parsed.imageKeys) {
        const attachment = await this.downloadResource(message.message_id, imageKey, 'image');
        if (attachment) attachments.push(attachment);
      }
    } else if (message.message_type === 'image' || message.message_type === 'file') {
      const fileKey = this.extractFileKey(message.content);
      if (fileKey) {
        const attachment = await this.downloadResource(message.message_id, fileKey, message.message_type);
        if (attachment) attachments.push(attachment);
      }
    }

    const inbound: InboundMessage = {
      messageId: message.message_id,
      address: {
        channelType: 'feishu',
        chatId,
        userId,
      },
      text: this.stripMentionMarkers(text).trim(),
      timestamp: Number.parseInt(message.create_time, 10) || Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: data,
    };

    await this.dispatch(inbound);
  }

  private async dispatch(message: InboundMessage): Promise<void> {
    try {
      await this.handler?.(message);
    } catch (error) {
      console.error('[feishu] inbound handler failed:', error instanceof Error ? error.stack || error.message : error);
    }
  }

  private isAuthorized(userId: string, chatId: string): boolean {
    const allowed = this.config.feishuAllowedUsers || [];
    if (allowed.length === 0) return true;
    return allowed.includes(userId) || allowed.includes(chatId);
  }

  private addDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size <= DEDUP_MAX) return;
    const excess = this.seenMessageIds.size - DEDUP_MAX;
    let removed = 0;
    for (const key of this.seenMessageIds.keys()) {
      this.seenMessageIds.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as Record<string, string>;
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const textParts: string[] = [];
    const imageKeys: string[] = [];
    try {
      const parsed = JSON.parse(content) as {
        title?: string;
        content?: Array<Array<Record<string, string>>>;
      };
      if (parsed.title) textParts.push(parsed.title);
      for (const paragraph of parsed.content || []) {
        for (const element of paragraph) {
          if (element.tag === 'text' || element.tag === 'a') {
            if (element.text) textParts.push(element.text);
          } else if (element.tag === 'img') {
            const key = element.image_key || element.file_key || element.imageKey;
            if (key) imageKeys.push(key);
          }
        }
        textParts.push('\n');
      }
    } catch {
      // ignore malformed content
    }
    return {
      extractedText: textParts.join('').trim(),
      imageKeys,
    };
  }

  private async resolveBotIdentity(domain: lark.Domain): Promise<void> {
    const baseUrl = domain === lark.Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    try {
      const tokenResponse = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.feishuAppId,
          app_secret: this.config.feishuAppSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData = await tokenResponse.json() as { tenant_access_token?: string };
      if (!tokenData.tenant_access_token) return;

      const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData = await botResponse.json() as {
        bot?: { open_id?: string; bot_id?: string };
      };
      if (botData.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      if (botData.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
    } catch (error) {
      console.warn('[feishu] resolve bot identity failed:', error instanceof Error ? error.message : error);
    }
  }

  private isBotMentioned(mentions?: FeishuMessageEventData['message']['mentions']): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((mention) => {
      const ids = [mention.id.open_id, mention.id.user_id, mention.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    return normalizeCallbackText(text.replace(/@_user_\d+/g, '').trim());
  }

  private async downloadResource(messageId: string, fileKey: string, resourceType: string): Promise<FileAttachment | null> {
    if (!this.restClient) return null;
    try {
      const response = await this.restClient.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType === 'image' ? 'image' : 'file' },
      });
      const readable = response.getReadableStream();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of readable) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_FILE_SIZE) return null;
        chunks.push(buffer);
      }
      const data = Buffer.concat(chunks);
      return {
        id: crypto.randomUUID(),
        name: `${fileKey}.${resourceType === 'image' ? 'png' : 'bin'}`,
        type: MIME_BY_TYPE[resourceType] || 'application/octet-stream',
        size: data.length,
        data: data.toString('base64'),
      };
    } catch (error) {
      console.warn('[feishu] download resource failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async sendLocalAttachment(chatId: string, filePath: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'file not found' };
    }
    if (!stat.isFile()) return { ok: false, error: 'path is not a file' };

    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    if (isImagePath(filePath)) {
      if (buffer.length === 0 || buffer.length > MAX_OUTBOUND_IMAGE_SIZE) {
        return { ok: false, error: 'image size out of range' };
      }
      try {
        const uploaded = await this.restClient.im.image.create({
          data: { image_type: 'message', image: buffer },
        });
        const imageKey = uploaded?.image_key;
        if (!imageKey) return { ok: false, error: 'image upload failed' };
        const sent = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });
        return sent?.data?.message_id
          ? { ok: true, messageId: sent.data.message_id }
          : { ok: false, error: sent?.msg || 'image send failed' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'image send failed' };
      }
    }

    if (buffer.length === 0 || buffer.length > MAX_OUTBOUND_FILE_SIZE) {
      return { ok: false, error: 'file size out of range' };
    }
    try {
      const uploaded = await this.restClient.im.file.create({
        data: {
          file_type: this.getOutboundFileType(fileName),
          file_name: fileName,
          file: buffer,
        },
      });
      const fileKey = uploaded?.file_key;
      if (!fileKey) return { ok: false, error: 'file upload failed' };
      const sent = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
      return sent?.data?.message_id
        ? { ok: true, messageId: sent.data.message_id }
        : { ok: false, error: sent?.msg || 'file send failed' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'file send failed' };
    }
  }

  private getOutboundFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.opus') return 'opus';
    if (ext === '.mp4') return 'mp4';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.doc' || ext === '.docx') return 'doc';
    if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return 'xls';
    if (ext === '.ppt' || ext === '.pptx') return 'ppt';
    return 'stream';
  }
}
