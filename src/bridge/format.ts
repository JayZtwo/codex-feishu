import path from 'node:path';
import type { ThreadSummary, ToolProgress } from './contracts.js';

const MARKDOWN_IMAGE_REF_RE = /!\[([^\]]*)\]\((\/[^)\s]+)\)/g;
const MARKDOWN_LINK_REF_RE = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;
const ABSOLUTE_PATH_RE = /(^|[\s(])((?:\/Users|\/tmp|\/private\/var\/folders|\/var\/folders)\/[^\s)<>\]]+)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico)$/i;

export function hasComplexMarkdown(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export function preprocessMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function buildMarkdownCard(text: string, title?: string, template = 'blue'): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: title
      ? {
          template,
          title: { tag: 'plain_text', content: title },
        }
      : undefined,
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

function summarizeTools(tools: ToolProgress[]): string {
  if (tools.length === 0) {
    return '';
  }

  const groups = new Map<string, { running: number; complete: number; error: number }>();
  for (const tool of tools) {
    const key = tool.name || 'Tool';
    const entry = groups.get(key) || { running: 0, complete: 0, error: 0 };
    entry[tool.status] += 1;
    groups.set(key, entry);
  }

  const running: string[] = [];
  const complete: string[] = [];
  const failed: string[] = [];
  for (const [name, counts] of groups) {
    if (counts.running > 0) running.push(`${name}${counts.running > 1 ? ` ×${counts.running}` : ''}`);
    if (counts.complete > 0) complete.push(`${name}${counts.complete > 1 ? ` ×${counts.complete}` : ''}`);
    if (counts.error > 0) failed.push(`${name}${counts.error > 1 ? ` ×${counts.error}` : ''}`);
  }

  const lines: string[] = [];
  if (running.length > 0) lines.push(`🔄 运行中: ${running.join(' · ')}`);
  if (complete.length > 0) lines.push(`✅ 已完成: ${complete.join(' · ')}`);
  if (failed.length > 0) lines.push(`❌ 失败: ${failed.join(' · ')}`);
  return lines.join('\n');
}

function compactPreview(text: string, maxChars: number): string {
  const normalized = preprocessMarkdown(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) {
    return 'Thinking';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n\n...[truncated ${normalized.length - maxChars} chars]`;
}

export function buildStreamingCard(text: string, tools: ToolProgress[], options?: {
  thinking?: boolean;
  status?: string;
  elapsed?: string;
}): string {
  const sections: string[] = [];
  if (options?.thinking && !text.trim()) {
    sections.push('Thinking');
  } else {
    sections.push(compactPreview(text, 8000));
  }

  const toolSummary = summarizeTools(tools);
  if (toolSummary) {
    sections.push('---', toolSummary);
  }

  if (options?.status || options?.elapsed) {
    const footer = [options.status, options.elapsed].filter(Boolean).join(' · ');
    if (footer) {
      sections.push('---', footer);
    }
  }

  return buildMarkdownCard(sections.filter(Boolean).join('\n'), 'Codex', options?.thinking ? 'wathet' : 'blue');
}

export function buildPermissionCard(body: string, permissionId: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'Permission Required' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow' },
            type: 'primary',
            value: { callback_data: `perm:allow:${permissionId}` },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow Session' },
            type: 'default',
            value: { callback_data: `perm:allow_session:${permissionId}` },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { callback_data: `perm:deny:${permissionId}` },
          },
        ],
      },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: 'Reply: `1` Allow · `2` Allow Session · `3` Deny' },
      },
    ],
  });
}

export function buildThreadPickerCard(threads: ThreadSummary[], currentSessionId: string): string {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: threads.length === 0
          ? '当前没有可切换的线程。'
          : '选择一个线程继续对话。也可以继续使用 `线程列表` 或 `切换线程 2`。',
      },
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '刷新列表' },
          type: 'default',
          value: { callback_data: 'thread:list' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '新线程' },
          type: 'primary',
          value: { callback_data: 'thread:new' },
        },
      ],
    },
  ];

  if (threads.length === 0) {
    return JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: 'Threads' },
      },
      elements,
    });
  }

  for (const [index, thread] of threads.slice(0, 8).entries()) {
    const summary = thread.latestUserPreview || thread.latestMessagePreview || thread.title;
    const meta = [
      thread.workingDirectory || '~',
      thread.lastActiveLabel,
      thread.source === 'local' ? 'local' : 'managed',
      thread.sessionId === currentSessionId ? 'current' : '',
    ].filter(Boolean).join(' | ');

    elements.push(
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${index + 1}. ${thread.displayId.slice(0, 8)}...**\n${summary}\n${meta}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: thread.sessionId === currentSessionId ? 'Current' : 'Switch' },
            type: thread.sessionId === currentSessionId ? 'default' : 'primary',
            disabled: thread.sessionId === currentSessionId,
            value: { callback_data: `thread:switch:${thread.displayId}` },
          },
        ],
      },
    );

    if (index < Math.min(threads.length, 8) - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Threads' },
    },
    elements,
  });
}

export function renderThreadListText(threads: ThreadSummary[], currentSessionId: string): string {
  if (threads.length === 0) {
    return 'Threads\n\nNo threads found.';
  }

  const lines = ['Threads', ''];
  for (const [index, thread] of threads.entries()) {
    const current = thread.sessionId === currentSessionId ? ' [current]' : '';
    lines.push(`${index + 1}. ${thread.displayId.slice(0, 8)}...${current}`);
    if (thread.latestUserPreview) {
      lines.push(`最近对话: ${thread.latestUserPreview}`);
    }
    if (thread.latestMessagePreview && thread.latestMessagePreview !== thread.latestUserPreview) {
      lines.push(`最近消息: ${thread.latestMessagePreview}`);
    }
    lines.push(`${thread.workingDirectory || '~'} | 最近活跃 ${thread.lastActiveLabel}`);
    lines.push('');
  }
  lines.push('切换: 切换线程 2');
  return lines.join('\n');
}

export function renderThreadDialogue(dialogue: { userText: string; assistantText: string }): string {
  const parts = ['Last dialogue'];
  if (dialogue.userText) {
    parts.push(`User:\n${dialogue.userText}`);
  }
  if (dialogue.assistantText) {
    parts.push(`Assistant:\n${dialogue.assistantText}`);
  }
  return parts.join('\n\n');
}

export function extractLocalFileReferences(text: string): { text: string; filePaths: string[] } {
  const filePaths = new Set<string>();
  let cleaned = text;

  cleaned = cleaned.replace(MARKDOWN_IMAGE_REF_RE, (_match, alt, filePath) => {
    filePaths.add(filePath);
    return alt ? `![${alt}]` : '';
  });

  cleaned = cleaned.replace(MARKDOWN_LINK_REF_RE, (match, label, filePath) => {
    if (!filePath.startsWith('/')) {
      return match;
    }
    filePaths.add(filePath);
    return label || path.basename(filePath);
  });

  cleaned = cleaned.replace(ABSOLUTE_PATH_RE, (match, prefix, filePath) => {
    filePaths.add(filePath);
    return prefix || '';
  });

  return {
    text: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    filePaths: Array.from(filePaths),
  };
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath);
}

export function formatElapsed(startedAtMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const seconds = Math.round(elapsedMs / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}
