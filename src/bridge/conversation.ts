import crypto from 'node:crypto';

import type {
  BridgeStore,
  ChannelBinding,
  FileAttachment,
  LLMProvider,
  PermissionRequestPayload,
  SSEEvent,
  TokenUsage,
  ToolProgress,
} from './contracts.js';

export interface ConversationCallbacks {
  onPartialText?: (fullText: string) => void;
  onTools?: (tools: ToolProgress[]) => void;
  onPermission?: (payload: PermissionRequestPayload) => Promise<void>;
}

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  sdkSessionId: string | null;
}

export async function runConversation(
  store: BridgeStore,
  llm: LLMProvider,
  binding: ChannelBinding,
  prompt: string,
  options?: {
    abortSignal?: AbortSignal;
    files?: FileAttachment[];
    callbacks?: ConversationCallbacks;
  },
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, 'codex-feishu', 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');
  const renewTimer = setInterval(() => {
    try {
      store.renewSessionLock(sessionId, lockId, 600);
    } catch {
      // best effort
    }
  }, 60_000);

  try {
    return await executeConversation(store, llm, binding, prompt, options);
  } finally {
    clearInterval(renewTimer);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

const OPERATIONAL_ASSISTANT_HISTORY_PATTERNS = [
  /you(?:['\u2019])?ve hit your usage limit/i,
  /upgrade to pro/i,
  /purchase more credits/i,
  /codex\/settings\/usage/i,
  /^codex 当前不可用/i,
  /^error(?:\s|$)/i,
  /^permission response recorded\.?$/i,
  /^unknown command:/i,
  /^working directory set to/i,
  /^mode set to/i,
  /^new thread created/i,
  /^switched thread/i,
  /^当前线程忙碌中$/i,
  /^no task is currently running\.?$/i,
  /^stopping current task/i,
  /^thread not found\.?$/i,
];

function shouldIncludeConversationHistoryMessage(role: 'user' | 'assistant', content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (role === 'user') {
    return !trimmed.startsWith('/');
  }

  return !OPERATIONAL_ASSISTANT_HISTORY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

async function executeConversation(
  store: BridgeStore,
  llm: LLMProvider,
  binding: ChannelBinding,
  prompt: string,
  options?: {
    abortSignal?: AbortSignal;
    files?: FileAttachment[];
    callbacks?: ConversationCallbacks;
  },
): Promise<ConversationResult> {
  const sessionId = binding.codepilotSessionId;
  const session = store.getSession(sessionId);
  const savedPrompt = buildSavedPrompt(prompt, options?.files);
  store.addMessage(sessionId, 'user', savedPrompt);

  const recentMessages = store.getMessages(sessionId, { limit: 50 }).messages;
  const history = recentMessages.slice(0, -1).map((message) => ({
    role: message.role as 'user' | 'assistant',
    content: message.content,
  })).filter((message) => shouldIncludeConversationHistoryMessage(message.role, message.content));

  const streamAbortController = new AbortController();
  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      streamAbortController.abort();
    } else {
      options.abortSignal.addEventListener('abort', () => streamAbortController.abort(), { once: true });
    }
  }

  const permissionMode = binding.mode === 'plan'
    ? 'plan'
    : binding.mode === 'ask'
      ? 'default'
      : 'acceptEdits';

  const stream = llm.streamChat({
    prompt,
    sessionId,
    sdkSessionId: binding.sdkSessionId || undefined,
    model: binding.model || session?.model || store.getSetting('default_model') || undefined,
    systemPrompt: session?.system_prompt || undefined,
    workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
    abortController: streamAbortController,
    permissionMode,
    provider: resolveProvider(store, session?.provider_id || ''),
    conversationHistory: history,
    files: options?.files,
    onRuntimeStatusChange: (status) => {
      try {
        store.setSessionRuntimeStatus(sessionId, status);
      } catch {
        // ignore
      }
    },
  });

  return consumeStream(store, sessionId, stream, options?.callbacks);
}

function resolveProvider(store: BridgeStore, providerId: string) {
  if (providerId && providerId !== 'env') {
    const provider = store.getProvider(providerId);
    if (provider) return provider;
  }

  const defaultProviderId = store.getDefaultProviderId();
  return defaultProviderId ? store.getProvider(defaultProviderId) : undefined;
}

function buildSavedPrompt(prompt: string, files?: FileAttachment[]): string {
  if (!files || files.length === 0) {
    return prompt;
  }
  return `[${files.length} attachment(s)] ${prompt}`;
}

async function consumeStream(
  store: BridgeStore,
  sessionId: string,
  stream: ReadableStream<string>,
  callbacks?: ConversationCallbacks,
): Promise<ConversationResult> {
  const reader = stream.getReader();
  const tools = new Map<string, ToolProgress>();
  let currentText = '';
  let finalText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let sdkSessionId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const line of value.split('\n')) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6)) as SSEEvent;
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            callbacks?.onPartialText?.(currentText);
            break;

          case 'tool_use': {
            const payload = tryParse<Record<string, unknown>>(event.data);
            if (!payload || typeof payload.id !== 'string') break;
            tools.set(payload.id, {
              id: payload.id,
              name: typeof payload.name === 'string' ? payload.name : 'Tool',
              status: 'running',
            });
            callbacks?.onTools?.(Array.from(tools.values()));
            break;
          }

          case 'tool_result': {
            const payload = tryParse<Record<string, unknown>>(event.data);
            if (!payload || typeof payload.tool_use_id !== 'string') break;
            const current = tools.get(payload.tool_use_id);
            tools.set(payload.tool_use_id, {
              id: payload.tool_use_id,
              name: current?.name || 'Tool',
              status: payload.is_error ? 'error' : 'complete',
            });
            callbacks?.onTools?.(Array.from(tools.values()));
            break;
          }

          case 'permission_request': {
            const payload = tryParse<PermissionRequestPayload>(event.data);
            if (!payload) break;
            await callbacks?.onPermission?.(payload);
            break;
          }

          case 'status': {
            const payload = tryParse<Record<string, unknown>>(event.data);
            if (!payload) break;
            if (typeof payload.session_id === 'string') {
              sdkSessionId = payload.session_id;
              store.updateSdkSessionId(sessionId, payload.session_id);
            }
            if (typeof payload.model === 'string') {
              store.updateSessionModel(sessionId, payload.model);
            }
            break;
          }

          case 'result': {
            const payload = tryParse<Record<string, unknown>>(event.data);
            if (!payload) break;
            if (typeof payload.session_id === 'string') {
              sdkSessionId = payload.session_id;
              store.updateSdkSessionId(sessionId, payload.session_id);
            }
            if (payload.usage && typeof payload.usage === 'object') {
              tokenUsage = payload.usage as TokenUsage;
            }
            if (typeof payload.final_text === 'string') {
              finalText = payload.final_text;
            }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          default:
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const responseText = (finalText || currentText).trim();
  if (responseText) {
    store.addMessage(sessionId, 'assistant', responseText, tokenUsage ? JSON.stringify(tokenUsage) : null);
  } else if (hasError && errorMessage) {
    store.addMessage(sessionId, 'assistant', errorMessage);
  }

  return {
    responseText: hasError && !responseText ? '' : responseText,
    tokenUsage,
    hasError,
    errorMessage,
    sdkSessionId,
  };
}

function tryParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
