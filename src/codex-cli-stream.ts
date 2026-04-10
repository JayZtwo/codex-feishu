import type { TokenUsage } from './bridge/contracts.js';

const OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const CSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE_PATTERN = /\u001B[@-Z\\-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const ALWAYS_IGNORED_PATTERNS = [
  /esc to interrupt/i,
  /^OpenAI Codex\b/,
  /^⚠ Heads up,/,
  /^╭/,
  /^│/,
  /^╰/,
  /^■ Conversation interrupted\b/,
];

const PRE_ANSWER_IGNORED_PATTERNS = [
  /^Tip:/,
  /^model:/i,
  /^directory:/i,
  /^Use \//,
  /^Run \//,
  /^Continue anyway\?/,
  /^gpt-[\w.-]+ /,
];

const MAX_TOOL_INPUT_CHARS = 4_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

export type CodexRolloutEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; content: string; isError: boolean }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'commentary'; text: string }
  | { kind: 'final_answer'; text: string }
  | { kind: 'task_complete'; lastAgentMessage?: string };

export function stripTerminalControl(text: string): string {
  return text
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(SINGLE_ESCAPE_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

function normalizeTerminalLine(rawLine: string): string {
  return stripTerminalControl(rawLine)
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+$/g, '');
}

function isIgnoredLine(line: string, sawAssistantOutput: boolean): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith('› ')) {
    return true;
  }
  if (ALWAYS_IGNORED_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  if (!sawAssistantOutput && PRE_ANSWER_IGNORED_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }
  return false;
}

function looksLikeAssistantStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('• ') && !/working/i.test(trimmed);
}

function looksLikeAssistantMarker(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '•' || looksLikeAssistantStart(line);
}

function isContinuationLine(line: string): boolean {
  return /^\s{4,}\S/.test(line);
}

function isSingleGlyph(text: string): boolean {
  return Array.from(text).length === 1;
}

function normalizeToolName(name: string): string {
  switch (name) {
    case 'exec_command':
    case 'write_stdin':
      return 'Bash';
    case 'apply_patch':
      return 'Edit';
    default:
      return name;
  }
}

function parseMaybeJson(value: string | undefined): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function limitToolPayload(value: unknown, maxChars: number): unknown {
  if (value == null) {
    return {};
  }
  if (typeof value === 'string') {
    return truncateText(value, maxChars);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) {
      return value;
    }
    return truncateText(serialized, maxChars);
  } catch {
    return '[unserializable tool payload]';
  }
}

function extractFinalAnswerText(payload: Record<string, unknown>): string | undefined {
  if (payload.phase !== 'final_answer') {
    return undefined;
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        const block = item as Record<string, unknown>;
        return block.type === 'output_text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('');
    return text || undefined;
  }

  return undefined;
}

export class CodexCliStdoutParser {
  private rawLineBuffer = '';
  private emittedText = '';
  private sawAssistantOutput = false;
  private charStreamMode = false;
  private recentLineKeys: string[] = [];
  private recentLineSet = new Set<string>();

  push(chunk: Buffer | string): string[] {
    this.rawLineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return this.drainCompleteLines();
  }

  flush(): string[] {
    const deltas = this.drainCompleteLines();
    if (this.rawLineBuffer.length > 0) {
      const delta = this.processLine(this.rawLineBuffer);
      if (delta) {
        deltas.push(delta);
      }
      this.rawLineBuffer = '';
    }
    return deltas;
  }

  getEmittedText(): string {
    return this.emittedText;
  }

  private drainCompleteLines(): string[] {
    const parts = this.rawLineBuffer.split('\n');
    this.rawLineBuffer = parts.pop() ?? '';

    const deltas: string[] = [];
    for (const part of parts) {
      const delta = this.processLine(part);
      if (delta) {
        deltas.push(delta);
      }
    }
    return deltas;
  }

  private processLine(rawLine: string): string | null {
    const line = normalizeTerminalLine(rawLine);
    if (isIgnoredLine(line, this.sawAssistantOutput)) {
      return null;
    }

    if (!this.sawAssistantOutput) {
      if (!looksLikeAssistantMarker(line)) {
        return null;
      }
      this.sawAssistantOutput = true;
      if (line.trim() === '•') {
        this.charStreamMode = true;
        return null;
      }
    }

    let fragment = line;
    if (looksLikeAssistantStart(line)) {
      fragment = line.trim().slice(2).trimStart();
    } else if (isContinuationLine(line)) {
      fragment = line.trim();
    } else {
      fragment = line.trimStart();
    }

    if (!fragment) {
      return null;
    }

    const singleGlyph = isSingleGlyph(fragment);
    if (!singleGlyph) {
      const key = `${isContinuationLine(line) ? 'c' : 'l'}:${fragment}`;
      if (this.recentLineSet.has(key)) {
        return null;
      }
      this.recentLineKeys.push(key);
      this.recentLineSet.add(key);
      if (this.recentLineKeys.length > 64) {
        const oldest = this.recentLineKeys.shift();
        if (oldest) {
          this.recentLineSet.delete(oldest);
        }
      }
    }

    const charStreamMode = this.charStreamMode || singleGlyph;
    const prefix = this.emittedText.length === 0
      ? ''
      : charStreamMode
        ? ''
        : isContinuationLine(line)
        ? ' '
        : '\n';
    const delta = `${prefix}${fragment}`;
    this.emittedText += delta;
    this.charStreamMode = singleGlyph;
    return delta;
  }
}

export function cleanTerminalOutput(raw: string): string {
  return raw
    .split('\n')
    .map((line) => normalizeTerminalLine(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !ALWAYS_IGNORED_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !PRE_ANSWER_IGNORED_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n');
}

export function parseCodexRolloutRecord(record: string): CodexRolloutEvent[] {
  const parsed = JSON.parse(record) as Record<string, unknown>;
  const payload = (parsed.payload ?? {}) as Record<string, unknown>;

  switch (parsed.type) {
    case 'session_meta': {
      const sessionId = payload.id;
      return typeof sessionId === 'string' && sessionId
        ? [{ kind: 'session', sessionId }]
        : [];
    }

    case 'response_item': {
      const itemType = payload.type;
      if (itemType === 'function_call') {
        const toolId = payload.call_id;
        const toolName = payload.name;
        if (typeof toolId !== 'string' || typeof toolName !== 'string') {
          return [];
        }
        return [{
          kind: 'tool_use',
          id: toolId,
          name: normalizeToolName(toolName),
          input: limitToolPayload(
            parseMaybeJson(typeof payload.arguments === 'string' ? payload.arguments : undefined),
            MAX_TOOL_INPUT_CHARS,
          ),
        }];
      }

      if (itemType === 'function_call_output') {
        const toolId = payload.call_id;
        if (typeof toolId !== 'string') {
          return [];
        }
        const output = typeof payload.output === 'string' && payload.output
          ? truncateText(payload.output, MAX_TOOL_RESULT_CHARS)
          : 'Done';
        return [{
          kind: 'tool_result',
          id: toolId,
          content: output,
          isError: false,
        }];
      }

      const finalText = extractFinalAnswerText(payload);
      return finalText ? [{ kind: 'final_answer', text: finalText }] : [];
    }

    case 'event_msg': {
      const eventType = payload.type;
      if (eventType === 'token_count') {
        const usage = (payload.info as Record<string, unknown> | undefined)?.total_token_usage as Record<string, unknown> | undefined;
        if (!usage) {
          return [];
        }
        return [{
          kind: 'usage',
          usage: {
            input_tokens: Number(usage.input_tokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? 0),
            cache_read_input_tokens: Number(usage.cached_input_tokens ?? 0),
          },
        }];
      }

      if (eventType === 'agent_message' && payload.phase === 'commentary') {
        const text = typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : undefined;
        return text ? [{ kind: 'commentary', text }] : [];
      }

      const finalText = eventType === 'agent_message' ? extractFinalAnswerText(payload) : undefined;
      if (eventType === 'task_complete') {
        const lastAgentMessage = typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()
          ? payload.last_agent_message
          : undefined;
        return [{ kind: 'task_complete', lastAgentMessage }];
      }
      return finalText ? [{ kind: 'final_answer', text: finalText }] : [];
    }

    default:
      return [];
  }
}
