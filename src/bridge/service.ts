import path from 'node:path';

import type { Config } from '../config.js';
import type { PendingPermissions } from '../permission-gateway.js';
import type { JsonFileStore, ThreadDialogue, ThreadSummary, ThreadToolState } from '../store.js';
import type {
  BridgeAdapter,
  ChannelType,
  ChannelBinding,
  InboundMessage,
  PermissionRequestPayload,
} from './contracts.js';
import { runConversation } from './conversation.js';
import { renderThreadDialogue } from './format.js';
import { FeishuAdapter } from './feishu.js';

const MAX_INPUT_LENGTH = 120_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function truncateInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_INPUT_LENGTH);
}

function isAbsoluteDir(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0') && !value.includes('/../') && !value.endsWith('/..');
}

function validateMode(value: string): value is 'code' | 'plan' | 'ask' {
  return value === 'code' || value === 'plan' || value === 'ask';
}

function looksLikePermissionShortcut(rawText: string): boolean {
  return /^[123]$/.test(normalizeText(rawText));
}

function mapThreadShortcut(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  const listAliases = new Set([
    '线程列表',
    '显示线程',
    '查看线程',
    '列出线程',
    '线程',
  ]);
  if (listAliases.has(normalized)) {
    return '/threads';
  }

  const switchPrefixes = ['切换线程', '切到线程', '切线程', '切换到线程'];
  for (const prefix of switchPrefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const target = normalized.slice(prefix.length).trim();
    return target ? `/thread switch ${target}` : '/threads';
  }
  return null;
}

function permissionResolutionFromAction(action: string): {
  behavior: 'allow' | 'deny';
  updatedPermissions?: unknown[];
} | null {
  if (action === 'allow') {
    return { behavior: 'allow' };
  }
  if (action === 'allow_session') {
    return { behavior: 'allow', updatedPermissions: [{ scope: 'session' }] };
  }
  if (action === 'deny') {
    return { behavior: 'deny' };
  }
  return null;
}

function buildInboundDedupKey(message: InboundMessage): string {
  const base = `${message.address.channelType}:${message.address.chatId}:${message.messageId}`;
  if (message.callbackData) {
    return `${base}:callback:${message.callbackData}`;
  }
  return `${base}:message`;
}

function shouldResetSdkSessionOnError(errorMessage: string): boolean {
  const normalized = normalizeText(errorMessage).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('resuming session with different model')
    || normalized.includes('no such session')
    || normalized.includes('no such thread')
    || normalized.includes('session not found')
    || normalized.includes('thread not found')
    || normalized.includes('invalid thread')
    || normalized.includes('failed to resume')
    || (normalized.includes('thread/resume') && normalized.includes('not found'))
    || (normalized.includes('resume') && normalized.includes('session'))
  );
}

type ActiveTask = {
  abortController: AbortController;
};

export class FeishuBridgeService {
  private readonly adapter: BridgeAdapter;
  private readonly channelType: ChannelType;
  private readonly sessionChains = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTask>();
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly store: JsonFileStore,
    private readonly permissions: PendingPermissions,
    private readonly llm: import('./contracts.js').LLMProvider,
    adapter?: BridgeAdapter,
  ) {
    this.adapter = adapter ?? new FeishuAdapter(config, store);
    this.channelType = this.adapter.channelType;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.adapter.start((message) => this.handleInbound(message));
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const task of this.activeTasks.values()) {
      task.abortController.abort();
    }
    this.activeTasks.clear();
    this.sessionChains.clear();
    await this.adapter.stop();
  }

  isRunning(): boolean {
    return this.running && this.adapter.isRunning();
  }

  getChannelType(): ChannelType {
    return this.channelType;
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    this.store.cleanupExpiredDedup();
    const dedupKey = buildInboundDedupKey(message);
    if (this.store.checkDedup(dedupKey)) {
      return;
    }
    this.store.insertDedup(dedupKey);

    if (message.callbackData) {
      await this.handleCallback(message);
      return;
    }

    const mappedThreadCommand = mapThreadShortcut(message.text);
    if (mappedThreadCommand) {
      await this.handleCommand(message, mappedThreadCommand);
      return;
    }

    if (message.text.startsWith('/')) {
      await this.handleCommand(message, message.text);
      return;
    }

    if (looksLikePermissionShortcut(message.text)) {
      const handled = await this.handlePermissionShortcut(message);
      if (handled) return;
    }

    const binding = this.resolveBinding(message.address.chatId);
    const chain = this.sessionChains.get(binding.codepilotSessionId) || Promise.resolve();
    const next = chain.then(
      () => this.handleConversationMessage(message, binding),
      () => this.handleConversationMessage(message, binding),
    );
    this.sessionChains.set(binding.codepilotSessionId, next);
    next.finally(() => {
      if (this.sessionChains.get(binding.codepilotSessionId) === next) {
        this.sessionChains.delete(binding.codepilotSessionId);
      }
    }).catch(() => {});
    await next;
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const callbackData = message.callbackData || '';
    if (callbackData.startsWith('perm:')) {
      const parts = callbackData.split(':');
      const action = parts[1];
      const permissionId = parts.slice(2).join(':');
      const handled = this.resolvePermission(permissionId, action);
      await this.adapter.sendText(
        message.address.chatId,
        handled ? 'Permission response recorded.' : 'Permission not found or already resolved.',
        message.callbackMessageId || message.messageId,
      );
      return;
    }

    if (callbackData.startsWith('thread:switch:')) {
      const identifier = callbackData.slice('thread:switch:'.length);
      await this.switchThread(message, identifier);
      return;
    }

    if (callbackData === 'thread:list') {
      const binding = this.resolveBinding(message.address.chatId);
      await this.showThreads(message, binding.codepilotSessionId);
      return;
    }

    if (callbackData === 'thread:new') {
      await this.createAndSwitchThread(message, this.config.defaultWorkDir);
      return;
    }
  }

  private async handlePermissionShortcut(message: InboundMessage): Promise<boolean> {
    const pendingLinks = this.store.listPendingPermissionLinksByChat(message.address.chatId);
    if (pendingLinks.length === 0) {
      return false;
    }
    if (pendingLinks.length > 1) {
      await this.adapter.sendText(
        message.address.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Please use /perm allow|allow_session|deny <id>.`,
        message.messageId,
      );
      return true;
    }

    const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
    const action = actionMap[normalizeText(message.text)];
    const handled = this.resolvePermission(pendingLinks[0].permissionRequestId, action);
    await this.adapter.sendText(
      message.address.chatId,
      handled ? `${action === 'allow' ? 'Allow' : action === 'allow_session' ? 'Allow Session' : 'Deny'}: recorded.` : 'Permission not found or already resolved.',
      message.messageId,
    );
    return true;
  }

  private async handleCommand(message: InboundMessage, rawText: string): Promise<void> {
    const normalized = normalizeText(rawText);
    const [rawCommand, ...rest] = normalized.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = rest.join(' ').trim();
    const binding = this.resolveBinding(message.address.chatId);

    switch (command) {
      case '/start':
      case '/help':
        await this.adapter.sendCommandReply(message.address.chatId, [
          `<b>Codex ${this.adapter.displayName}</b>`,
          '',
          '/new [path] - Start a new thread',
          '/cwd /abs/path - Change working directory',
          '/mode code|plan|ask - Change mode',
          '/status - Show current thread',
          '/threads - Show thread picker',
          '/thread switch <id|index> - Switch thread',
          '/stop - Stop current task',
          '/perm allow|allow_session|deny <id> - Resolve permission',
          '/permtest - Trigger an approval test',
        ].join('\n'), message.messageId);
        return;

      case '/new': {
        const workDir = args && isAbsoluteDir(args) ? args : this.config.defaultWorkDir;
        await this.createAndSwitchThread(message, workDir);
        return;
      }

      case '/cwd': {
        if (!args || !isAbsoluteDir(args)) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /cwd /absolute/path', message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, { workingDirectory: args });
        this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, { workingDirectory: args });
        await this.adapter.sendCommandReply(message.address.chatId, `Working directory set to <code>${escapeHtml(args)}</code>`, message.messageId);
        return;
      }

      case '/mode': {
        if (!validateMode(args)) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /mode code|plan|ask', message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, { mode: args });
        await this.adapter.sendCommandReply(message.address.chatId, `Mode set to <b>${args}</b>`, message.messageId);
        return;
      }

      case '/status': {
        const summary = this.store.describeChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId);
        const busy = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
        const lines = [
          `<b>Codex ${this.adapter.displayName} Status</b>`,
          '',
          `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
          `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
          `Mode: <b>${binding.mode}</b>`,
          `Model: <code>${escapeHtml(binding.model || 'default')}</code>`,
        ];
        if (summary?.latestUserPreview) {
          lines.push(`Recent: ${escapeHtml(summary.latestUserPreview)}`);
        }
        if (busy) {
          lines.push('Busy: <b>desktop thread active</b>');
        }
        await this.adapter.sendCommandReply(message.address.chatId, lines.join('\n'), message.messageId);
        return;
      }

      case '/threads':
        await this.showThreads(message, binding.codepilotSessionId);
        return;

      case '/thread':
        if (!args) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /thread list | /thread switch <index|id>', message.messageId);
          return;
        }
        if (args === 'list') {
          await this.showThreads(message, binding.codepilotSessionId);
          return;
        }
        if (args.startsWith('switch ')) {
          await this.switchThread(message, args.slice('switch '.length).trim());
          return;
        }
        if (args === 'new') {
          await this.createAndSwitchThread(message, this.config.defaultWorkDir);
          return;
        }
        await this.adapter.sendText(message.address.chatId, 'Usage: /thread list | /thread switch <index|id>', message.messageId);
        return;

      case '/stop': {
        const active = this.activeTasks.get(binding.codepilotSessionId);
        if (!active) {
          await this.adapter.sendText(message.address.chatId, 'No task is currently running.', message.messageId);
          return;
        }
        active.abortController.abort();
        this.activeTasks.delete(binding.codepilotSessionId);
        await this.adapter.sendText(message.address.chatId, 'Stopping current task...', message.messageId);
        return;
      }

      case '/perm': {
        const [action, permissionId] = args.split(/\s+/, 2);
        if (!action || !permissionId) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /perm allow|allow_session|deny <id>', message.messageId);
          return;
        }
        const handled = this.resolvePermission(permissionId, action);
        await this.adapter.sendText(
          message.address.chatId,
          handled ? `Permission ${action}: recorded.` : 'Permission not found or already resolved.',
          message.messageId,
        );
        return;
      }

      case '/permtest':
        await this.runPermissionTest(message, binding);
        return;

      default:
        await this.adapter.sendText(message.address.chatId, `Unknown command: ${command}`, message.messageId);
    }
  }

  private async showThreads(message: InboundMessage, currentSessionId: string): Promise<void> {
    const threads = this.store.listChatThreads(this.channelType, message.address.chatId);
    await this.adapter.sendThreadPicker(message.address.chatId, threads, currentSessionId, message.messageId);
  }

  private async createAndSwitchThread(message: InboundMessage, workDir?: string): Promise<void> {
    const newBinding = this.createBinding(message.address.chatId, workDir);
    await this.adapter.sendCommandReply(
      message.address.chatId,
      `New thread created.\nSession: <code>${newBinding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(newBinding.workingDirectory)}</code>`,
      message.messageId,
    );
  }

  private async switchThread(message: InboundMessage, identifier: string): Promise<void> {
    const currentBinding = this.resolveBinding(message.address.chatId);
    const target = this.store.findChatThread(this.channelType, message.address.chatId, identifier);
    if (!target) {
      await this.adapter.sendText(message.address.chatId, 'Thread not found.', message.messageId);
      return;
    }

    const resolved = target.importable
      ? this.store.importChatThread(this.channelType, message.address.chatId, target.sdkSessionId)
      : target;

    if (!resolved) {
      await this.adapter.sendText(message.address.chatId, 'Thread import failed.', message.messageId);
      return;
    }

    this.store.updateChannelBinding(currentBinding.id, {
      codepilotSessionId: resolved.sessionId,
      sdkSessionId: resolved.sdkSessionId,
      workingDirectory: resolved.workingDirectory,
      model: resolved.model,
      updatedAt: new Date().toISOString(),
    });
    this.store.touchChatThread(this.channelType, message.address.chatId, resolved.sessionId, {
      workingDirectory: resolved.workingDirectory,
      model: resolved.model,
      title: resolved.title,
      touch: false,
    });

    await this.adapter.sendCommandReply(
      message.address.chatId,
      `Switched thread\nThread: <code>${escapeHtml(resolved.displayId.slice(0, 8))}...</code>\nTitle: ${escapeHtml(resolved.title)}\nCWD: <code>${escapeHtml(resolved.workingDirectory || '~')}</code>`,
      message.messageId,
    );

    const mirrored = await this.maybeMirrorBusyThread(message, this.resolveBinding(message.address.chatId));
    if (mirrored) {
      return;
    }

    const dialogue = this.store.getThreadLatestDialogue(resolved.sessionId);
    if (dialogue && (dialogue.userText || dialogue.assistantText)) {
      await this.adapter.sendMarkdown(message.address.chatId, renderThreadDialogue(dialogue), message.messageId);
    }
  }

  private async runPermissionTest(message: InboundMessage, binding: ChannelBinding): Promise<void> {
    await this.handleConversationMessage({
      ...message,
      text: 'Run a harmless shell command that requires approval: create and then remove ~/.codex-feishu/.permtest-smoke . Do not do anything else.',
    }, binding);
  }

  private async handleConversationMessage(message: InboundMessage, binding: ChannelBinding): Promise<void> {
    const mirrored = await this.maybeMirrorBusyThread(message, binding);
    if (mirrored) return;

    const prompt = truncateInput(message.text || (message.attachments?.length ? 'Describe this attachment.' : ''));
    if (!prompt && !message.attachments?.length) {
      return;
    }

    this.adapter.beginResponse(message.address.chatId, message.messageId);
    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let partialText = '';
    let tools: ThreadToolState[] = [];

    try {
      const result = await runConversation(this.store, this.llm, binding, prompt, {
        abortSignal: abortController.signal,
        files: message.attachments,
        callbacks: {
          onPartialText: (fullText) => {
            partialText = fullText;
            this.adapter.updateResponse(message.address.chatId, fullText, tools);
          },
          onTools: (nextTools) => {
            tools = nextTools;
            this.adapter.updateResponse(message.address.chatId, partialText, tools);
          },
          onPermission: async (payload) => {
            await this.forwardPermissionRequest(message, binding, payload);
          },
        },
      });

      if (binding.id) {
        const nextSdkSessionId = result.sdkSessionId || binding.sdkSessionId;
        if (nextSdkSessionId && !shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: nextSdkSessionId });
        } else if (result.hasError && shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: '' });
        }
      }
      this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, {
        workingDirectory: binding.workingDirectory,
        model: binding.model,
      });

      if (result.responseText) {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', result.responseText, message.messageId);
      } else if (result.hasError) {
        await this.adapter.finalizeResponse(
          message.address.chatId,
          'error',
          `Error\n\n${result.errorMessage}`,
          message.messageId,
        );
      } else {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', 'Done.', message.messageId);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const status = abortController.signal.aborted ? 'interrupted' : 'error';
      await this.adapter.finalizeResponse(message.address.chatId, status, messageText, message.messageId);
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }
  }

  private async maybeMirrorBusyThread(message: InboundMessage, binding: ChannelBinding): Promise<boolean> {
    const busyThread = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
    if (!busyThread) {
      return false;
    }

    await this.adapter.sendText(message.address.chatId, '当前线程忙碌中', message.messageId);
    this.adapter.beginResponse(message.address.chatId, message.messageId);

    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let finalText = busyThread.previewText || '';
    let tools: ThreadToolState[] = busyThread.tools;
    this.adapter.updateResponse(message.address.chatId, finalText, tools);

    try {
      const result = await this.store.followBusyLocalThread(binding.codepilotSessionId, {
        abortSignal: abortController.signal,
        onText: (fullText) => {
          finalText = fullText;
          this.adapter.updateResponse(message.address.chatId, finalText, tools);
        },
        onTools: (nextTools) => {
          tools = nextTools;
          this.adapter.updateResponse(message.address.chatId, finalText, tools);
        },
      });

      if (result.completed) {
        const synced = this.store.syncImportedThreadFromLocalSource(binding.codepilotSessionId);
        if (!finalText) {
          finalText = synced?.assistantText || synced?.userText || '';
        }
      }

      await this.adapter.finalizeResponse(
        message.address.chatId,
        result.completed ? 'completed' : 'interrupted',
        finalText,
        message.messageId,
      );
    } catch (error) {
      await this.adapter.finalizeResponse(
        message.address.chatId,
        abortController.signal.aborted ? 'interrupted' : 'error',
        finalText || (error instanceof Error ? error.message : String(error)),
        message.messageId,
      );
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }

    return true;
  }

  private async forwardPermissionRequest(
    message: InboundMessage,
    binding: ChannelBinding,
    payload: PermissionRequestPayload,
  ): Promise<void> {
    if (this.channelType === 'rokid' && this.config.rokidAutoAllowPermissions) {
      const resolution: { behavior: 'allow'; updatedPermissions: unknown[] } = {
        behavior: 'allow',
        updatedPermissions: [{ scope: 'session' }],
      };
      if (!this.permissions.resolve(payload.permissionRequestId, resolution)) {
        setTimeout(() => {
          this.permissions.resolve(payload.permissionRequestId, resolution);
        }, 0);
      }
      await this.adapter.sendPermissionRequest(
        message.address.chatId,
        [
          `Auto-allowed for Rokid channel.`,
          '',
          `**Tool:** \`${payload.toolName}\``,
          '',
          '```json',
          JSON.stringify(payload.toolInput, null, 2).slice(0, 4000),
          '```',
          '',
          `Thread: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        ].join('\n'),
        payload.permissionRequestId,
        message.messageId,
      );
      return;
    }

    this.store.insertPermissionLink({
      permissionRequestId: payload.permissionRequestId,
      channelType: this.channelType,
      chatId: message.address.chatId,
      messageId: message.messageId,
      toolName: payload.toolName,
      suggestions: JSON.stringify(payload.suggestions || []),
    });

    const body = [
      `**Tool:** \`${payload.toolName}\``,
      '',
      '```json',
      JSON.stringify(payload.toolInput, null, 2).slice(0, 4000),
      '```',
      '',
      `Thread: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
    ].join('\n');

    await this.adapter.sendPermissionRequest(
      message.address.chatId,
      body,
      payload.permissionRequestId,
      message.messageId,
    );
  }

  private resolvePermission(permissionId: string, action: string): boolean {
    const resolution = permissionResolutionFromAction(action);
    if (!resolution) return false;
    const claimed = this.store.markPermissionLinkResolved(permissionId);
    if (!claimed) return false;
    return this.permissions.resolve(permissionId, resolution);
  }

  private resolveBinding(chatId: string): ChannelBinding {
    const existing = this.store.getChannelBinding(this.channelType, chatId);
    if (existing) {
      const session = this.store.getSession(existing.codepilotSessionId);
      if (session) return existing;
    }
    return this.createBinding(chatId, this.config.defaultWorkDir);
  }

  private createBinding(chatId: string, workDir?: string): ChannelBinding {
    const workingDirectory = workDir || this.config.defaultWorkDir;
    const model = this.config.defaultModel || '';
    const session = this.store.createSession(
      `${this.adapter.displayName} ${chatId}`,
      model,
      undefined,
      workingDirectory,
      this.config.defaultMode,
    );
    const defaultProviderId = this.store.getDefaultProviderId();
    if (defaultProviderId) {
      this.store.updateSessionProviderId(session.id, defaultProviderId);
    }
    const binding = this.store.upsertChannelBinding({
      channelType: this.channelType,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      model: session.model,
    });
    this.store.touchChatThread(this.channelType, chatId, binding.codepilotSessionId, {
      workingDirectory: session.working_directory,
      model: session.model,
      title: `thread · ${session.id.slice(0, 8)}`,
      touch: false,
    });
    return binding;
  }
}
