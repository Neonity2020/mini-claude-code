import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

type Request = { model: string; system?: string; messages: MessageParam[]; max_tokens: number; tools?: Array<{ name: string; description?: string; input_schema: unknown }> };
type ChatMessage = Record<string, unknown>;

/** Convert the agent's message history to the OpenAI Chat Completions protocol. */
export function toOpenAIMessages(messages: MessageParam[], system?: string): ChatMessage[] {
  const result: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (typeof message.content === 'string') { result.push({ role: message.role, content: message.content }); continue; }
    if (message.role === 'assistant') {
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = message.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      const reasoning = (message as MessageParam & { reasoning_content?: string }).reasoning_content;
      result.push({ role: 'assistant', content: text || null, ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const block of message.content) {
        if (block.type === 'tool_result') result.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') });
        else if (block.type === 'text') result.push({ role: 'user', content: block.text });
      }
    }
  }
  return result;
}

type Chunk = { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; error?: { message?: string } };

export function createOpenAIClient(options: { apiKey: string; baseURL?: string; fetch?: typeof fetch }): Anthropic {
  const base = (options.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const request = async (params: Request, stream: boolean, signal?: AbortSignal) => {
    const response = await (options.fetch ?? fetch)(`${base}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: params.model, messages: toOpenAIMessages(params.messages, params.system), stream,
        ...(params.tools?.length ? { tools: params.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API 错误 (${response.status}): ${(await response.text()).slice(0, 2000)}`);
    return response;
  };
  const client = { messages: {
    stream(params: Request, options?: { signal?: AbortSignal }) {
      let onText: (delta: string) => void = () => {};
      return {
        on(event: string, cb: (delta: string) => void) { if (event === 'text') onText = cb; },
        async finalMessage() {
          const response = await request(params, true, options?.signal);
          if (!response.body) throw new Error('OpenAI API 没有返回流');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = ''; let text = ''; let reasoning = ''; let hasReasoning = false; let finish: string | null = null; let done = false;
          const calls = new Map<number, { id: string; name: string; args: string }>();
          const event = (raw: string) => {
            const data = raw.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data) return;
            if (data === '[DONE]') { done = true; return; }
            const chunk = JSON.parse(data) as Chunk;
            if (chunk.error) throw new Error(chunk.error.message || 'OpenAI 流返回错误');
            const choice = chunk.choices?.[0];
            if (!choice) return;
            if (choice.finish_reason) finish = choice.finish_reason;
            if (choice.delta?.reasoning_content != null) { reasoning += choice.delta.reasoning_content; hasReasoning = true; }
            if (choice.delta?.content) { text += choice.delta.content; onText(choice.delta.content); }
            for (const part of choice.delta?.tool_calls ?? []) {
              const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
              if (part.id) call.id += part.id;
              if (part.function?.name) call.name += part.function.name;
              if (part.function?.arguments) call.args += part.function.arguments;
              calls.set(part.index, call);
            }
          };
          while (true) {
            const item = await reader.read();
            buffer += decoder.decode(item.value, { stream: !item.done });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) { event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
            if (item.done) break;
          }
          if (buffer.trim()) event(buffer);
          if (!done || !finish) throw new Error('OpenAI 流提前中断');
          if (finish !== 'stop' && finish !== 'tool_calls') throw new Error(`OpenAI 响应未完成：${finish}`);
          const content: Array<Record<string, unknown>> = text ? [{ type: 'text', text }] : [];
          for (const call of calls.values()) {
            if (!call.id || !call.name) throw new Error('OpenAI 工具调用缺少 ID 或名称');
            let input: unknown;
            try { input = JSON.parse(call.args || '{}'); } catch { throw new Error(`OpenAI 工具 ${call.name} 返回无效 JSON`); }
            content.push({ type: 'tool_use', id: call.id, name: call.name, input });
          }
          if (finish === 'tool_calls' && !calls.size) throw new Error('OpenAI 未返回工具调用');
          return { content, stop_reason: calls.size ? 'tool_use' : 'end_turn', ...(hasReasoning ? { reasoning_content: reasoning } : {}) };
        },
      };
    },
    async create(params: Request, options?: { signal?: AbortSignal }) {
      const response = await request(params, false, options?.signal);
      const json = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
      };
      const choice = json.choices?.[0];
      if (!choice) throw new Error('OpenAI 响应缺少 choices');

      const finish = choice.finish_reason;
      if (finish === 'length') throw new Error('OpenAI 响应被 max_tokens 截断');
      if (finish && finish !== 'stop' && finish !== 'tool_calls') {
        throw new Error(`OpenAI 响应未完成：${finish}`);
      }

      const content: Array<Record<string, unknown>> = [];
      const text = choice.message?.content ?? '';
      if (text) content.push({ type: 'text', text });

      for (const call of choice.message?.tool_calls ?? []) {
        const name = call.function?.name;
        if (!call.id || !name) throw new Error('OpenAI 工具调用缺少 ID 或名称');
        let input: unknown;
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch { throw new Error(`OpenAI 工具 ${name} 返回无效 JSON`); }
        content.push({ type: 'tool_use', id: call.id, name, input });
      }

      const reasoning = choice.message?.reasoning_content;
      return {
        content,
        stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        ...(reasoning != null ? { reasoning_content: reasoning } : {}),
      };
    },
  } };
  return client as unknown as Anthropic;
}
