const DEFAULT_TRUNCATE = 8 * 1024;

export function truncateText(value, max = DEFAULT_TRUNCATE) {
  const text = String(value ?? '');
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…[truncated ${text.length - max} chars]`, truncated: true };
}

export function jsonPreview(value, max = DEFAULT_TRUNCATE) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    const truncated = truncateText(text, max);
    return truncated.truncated ? { _truncated: true, preview: truncated.text } : value;
  } catch {
    return { _truncated: true, preview: '[unserializable value]' };
  }
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content === 'string') return block.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Converts one line of Claude Code `--output-format stream-json` output into
 * zero or more normalized process events.
 *
 * Verified against Claude Code 2.1.236:
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]},...}
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]},...}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{...}},...}
 *   {"type":"result","is_error":bool,"result":"...","subtype":"success",...}
 */
export function normalizeCliEvent(event) {
  if (!event || typeof event !== 'object') return [];

  switch (event.type) {
    case 'system':
      return [normalizeSystem(event)];
    case 'assistant':
      return normalizeAssistant(event);
    case 'user':
      return normalizeUser(event);
    case 'stream_event':
      return normalizeStreamEvent(event);
    case 'result':
      return [normalizeResult(event)];
    default:
      return [{ kind: 'raw', cli_type: String(event.type ?? 'unknown'), raw: jsonPreview(event) }];
  }
}

function normalizeSystem(event) {
  if (event.subtype === 'init') {
    return {
      kind: 'system',
      subtype: 'init',
      session_id: event.session_id,
      cwd: event.cwd,
      model: event.model,
      permission_mode: event.permissionMode,
      api_key_source: event.apiKeySource,
      claude_code_version: event.claude_code_version,
      tools: Array.isArray(event.tools) ? event.tools : undefined,
    };
  }
  if (event.subtype === 'hook_started' || event.subtype === 'hook_response') {
    return {
      kind: 'hook',
      subtype: event.subtype,
      hook_name: event.hook_name,
      hook_event: event.hook_event,
      outcome: event.outcome,
      exit_code: event.exit_code,
    };
  }
  return {
    kind: 'system',
    subtype: String(event.subtype ?? 'unknown'),
    raw: jsonPreview(event),
  };
}

function normalizeAssistant(event) {
  const message = event.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const normalized = [];

  if (typeof event.error === 'string' && event.error) {
    normalized.push({
      kind: 'cli_error',
      code: event.error,
      message: contentToText(message.content) || event.error,
    });
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      normalized.push({ kind: 'assistant_text', text: block.text });
      continue;
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      normalized.push({ kind: 'assistant_thinking', text: block.thinking });
      continue;
    }
    if (block.type === 'tool_use') {
      normalized.push({
        kind: 'tool_use',
        tool_use_id: block.id,
        name: block.name,
        input: jsonPreview(block.input),
      });
      continue;
    }
    if (block.type === 'tool_result') {
      const text = contentToText(block.content);
      const truncated = truncateText(text);
      normalized.push({
        kind: 'tool_result',
        tool_use_id: block.tool_use_id,
        is_error: Boolean(block.is_error),
        text: truncated.text,
        truncated: truncated.truncated,
      });
      continue;
    }
    normalized.push({ kind: 'assistant_block', block_type: String(block.type ?? 'unknown'), raw: jsonPreview(block) });
  }

  return normalized;
}

function normalizeUser(event) {
  const message = event.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const normalized = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      const truncated = truncateText(contentToText(block.content));
      normalized.push({
        kind: 'tool_result',
        tool_use_id: block.tool_use_id,
        is_error: Boolean(block.is_error),
        text: truncated.text,
        truncated: truncated.truncated,
      });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      normalized.push({ kind: 'user_text', text: block.text });
      continue;
    }
    normalized.push({ kind: 'user_block', block_type: String(block.type ?? 'unknown'), raw: jsonPreview(block) });
  }

  return normalized;
}

function normalizeStreamEvent(event) {
  const inner = event.event;
  if (!inner || typeof inner !== 'object') {
    return [{ kind: 'raw', cli_type: 'stream_event', raw: jsonPreview(event) }];
  }

  if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta === 'object') {
    if (inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string') {
      return [{ kind: 'delta', delta_type: 'text', text: inner.delta.text }];
    }
    if (inner.delta.type === 'thinking_delta' && typeof inner.delta.thinking === 'string') {
      return [{ kind: 'delta', delta_type: 'thinking', text: inner.delta.thinking }];
    }
  }

  if (inner.type === 'content_block_start' && inner.content_block && typeof inner.content_block === 'object') {
    if (inner.content_block.type === 'tool_use') {
      return [
        {
          kind: 'delta',
          delta_type: 'tool_use_start',
          tool_use_id: inner.content_block.id,
          name: inner.content_block.name,
        },
      ];
    }
  }

  // message_start/stop, ping, etc. carry no incremental content useful to clients.
  return [];
}

function normalizeResult(event) {
  return {
    kind: 'result',
    is_error: Boolean(event.is_error),
    subtype: event.subtype,
    text: typeof event.result === 'string' ? event.result : '',
    session_id: event.session_id,
    total_cost_usd: event.total_cost_usd,
    duration_ms: event.duration_ms,
    duration_api_ms: event.duration_api_ms,
    num_turns: event.num_turns,
    stop_reason: event.stop_reason,
    terminal_reason: event.terminal_reason,
    api_error_status: event.api_error_status,
    usage: event.usage,
    permission_denials: Array.isArray(event.permission_denials) ? event.permission_denials : [],
    model_usage: event.modelUsage,
  };
}

export function mapResultError(resultEvent) {
  const text = String(resultEvent?.text ?? '').trim();
  const status = Number(resultEvent?.api_error_status);
  const fallbackMessage = text || 'Claude Code returned an error result';

  if (status === 401 || status === 403 || /authenticat|unauthor|invalid\s+api\s*key|api\s+key/i.test(text)) {
    return { code: 'claude_auth_failed', message: fallbackMessage, details: { api_error_status: status || null } };
  }
  if (status === 429) {
    return { code: 'claude_rate_limited', message: fallbackMessage, details: { api_error_status: 429 } };
  }
  if (status >= 400) {
    return { code: 'claude_api_error', message: fallbackMessage, details: { api_error_status: status } };
  }
  if (typeof resultEvent?.subtype === 'string' && resultEvent.subtype !== 'success') {
    return { code: `claude_${resultEvent.subtype}`, message: fallbackMessage };
  }
  return { code: 'claude_failed', message: fallbackMessage };
}
