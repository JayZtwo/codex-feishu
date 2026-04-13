export type BridgeMode = 'code' | 'plan' | 'ask';
export type ChannelType = 'feishu' | 'rokid';

export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  userId?: string;
  displayName?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  filePath?: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

export interface BridgeApiProvider {
  id: string;
  [key: string]: unknown;
}

export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}

export interface BridgeMessage {
  role: string;
  content: string;
}

export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  model: string;
  mode: BridgeMode;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogInput {
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

export interface PermissionLinkInput {
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
}

export interface PermissionLinkRecord {
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
}

export interface OutboundRefInput {
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose: string;
}

export interface UpsertChannelBindingInput {
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  workingDirectory: string;
  model: string;
}

export interface BridgeStore {
  getSetting(key: string): string | null;
  getChannelBinding(channelType: ChannelType, chatId: string): ChannelBinding | null;
  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
  listChannelBindings(channelType?: ChannelType): ChannelBinding[];
  getSession(id: string): BridgeSession | null;
  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    mode?: string,
  ): BridgeSession;
  updateSessionProviderId(sessionId: string, providerId: string): void;
  addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };
  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
  releaseSessionLock(sessionId: string, lockId: string): void;
  setSessionRuntimeStatus(sessionId: string, status: string): void;
  updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
  updateSessionModel(sessionId: string, model: string): void;
  syncSdkTasks(sessionId: string, todos: unknown): void;
  getProvider(id: string): BridgeApiProvider | undefined;
  getDefaultProviderId(): string | null;
  insertAuditLog(entry: AuditLogInput): void;
  checkDedup(key: string): boolean;
  insertDedup(key: string): void;
  cleanupExpiredDedup(): void;
  insertOutboundRef(ref: OutboundRefInput): void;
  insertPermissionLink(link: PermissionLinkInput): void;
  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
  markPermissionLinkResolved(permissionRequestId: string): boolean;
  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[];
  getChannelOffset(key: string): string;
  setChannelOffset(key: string, offset: string): void;
}

export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  provider?: BridgeApiProvider;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];
  onRuntimeStatusChange?: (status: string) => void;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
}

export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export interface InboundMessage {
  messageId: string;
  address: ChannelAddress;
  text: string;
  timestamp: number;
  callbackData?: string;
  callbackMessageId?: string;
  raw?: unknown;
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ToolProgress {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

export interface PermissionRequestPayload {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

export interface ThreadSummary {
  sessionId: string;
  sdkSessionId: string;
  displayId: string;
  title: string;
  workingDirectory: string;
  model: string;
  latestMessagePreview: string;
  latestMessageRole: string;
  latestUserPreview: string;
  lastActiveLabel: string;
  source: 'managed' | 'local';
  importable: boolean;
}

export interface ThreadDialogue {
  userText: string;
  assistantText: string;
}

export interface BridgeAdapter {
  channelType: ChannelType;
  displayName: string;
  start(handler: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  sendText(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult>;
  sendHtml(chatId: string, html: string, replyToMessageId?: string): Promise<SendResult>;
  sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<SendResult>;
  sendPermissionRequest(chatId: string, body: string, permissionId: string, replyToMessageId?: string): Promise<SendResult>;
  sendThreadPicker(
    chatId: string,
    threads: ThreadSummary[],
    currentSessionId: string,
    replyToMessageId?: string,
  ): Promise<SendResult>;
  sendCommandReply(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  beginResponse(chatId: string, replyToMessageId?: string): void;
  updateResponse(chatId: string, fullText: string, tools: ToolProgress[]): void;
  finalizeResponse(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    finalText: string,
    replyToMessageId?: string,
  ): Promise<boolean>;
}
