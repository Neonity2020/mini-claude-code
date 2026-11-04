import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { ContextManager } from './context.js';
import { PermissionManager } from './permissions.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolContext, ToolResult, TodoItem } from './tools/types.js';
import { FileReadTrackerImpl } from './tools/fs-utils.js';
import { paintIf, symbols } from './ui.js';

export interface AgentOptions {
  client: Anthropic;
  tools: ToolRegistry;
  permissions?: PermissionManager;
  contextManager?: ContextManager;
  systemPrompt: string;
  model: string;
  cwd: string;
  maxTurns?: number;
  /** 流式输出文本时的回调 */
  onText?: (delta: string) => void;
  /** 工具开始执行时的回调 */
  onToolStart?: (name: string, input: unknown) => void;
  /** 工具执行结束时的回调 */
  onToolEnd?: (name: string, result: ToolResult) => void;
  /** 需要用户确认时的回调 */
  onConfirm?: (request: { title: string; detail: string; target: string }) => Promise<boolean>;
}

export class Agent {
  readonly #options: AgentOptions;
  readonly #messages: MessageParam[] = [];
  readonly #todos: ToolContext['todos'] = [];
  readonly #fileReads = new FileReadTrackerImpl();
  #controller = new AbortController();

  constructor(options: AgentOptions) {
    this.#options = options;
  }

  /** 当前会话的全部消息（调试用） */
  get messages(): readonly MessageParam[] {
    return this.#messages;
  }

  get todos(): readonly TodoItem[] {
    return this.#todos;
  }

  /** 取消当前正在进行的回合 */
  abort(): void {
    this.#controller.abort();
  }

  /**
   * 处理一轮用户输入。
   *
   * 核心就是一个 while 循环：
   * 请求模型 → 如果模型要求调用工具，执行工具 → 把结果喂回去 → 再请求
   * 直到模型不再要求调用工具。
   */
  async run(userInput: string): Promise<void> {
    this.#controller = new AbortController();
    const checkpoint = this.#messages.slice();
    this.#messages.push({ role: 'user', content: userInput });
    try {

    const maxTurns = this.#options.maxTurns ?? 50;

    for (let turn = 0; turn < maxTurns; turn++) {
      await this.#maybeCompact();

      const assistantMessage = await this.#callModel();
      const reasoning = (assistantMessage as typeof assistantMessage & { reasoning_content?: string }).reasoning_content;
      this.#messages.push({ role: 'assistant', content: assistantMessage.content, ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) });

      const toolUses = assistantMessage.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      );

      // 没有工具调用 -> 这一轮结束
      if (assistantMessage.stop_reason !== 'tool_use' || toolUses.length === 0) {
        return;
      }

      // 串行执行，避免写入竞争和确认提示交错。
      const results: ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) results.push(await this.#runTool(toolUse));

      // 工具结果必须作为 user 消息回传，这是 Anthropic API 的协议要求
      this.#messages.push({ role: 'user', content: results });
    }

    throw new Error(`已达到最大轮数限制（${maxTurns}），强制结束。`);
    } catch (error) {
      // Discard incomplete tool exchanges so the next request has valid history.
      this.#messages.splice(0, this.#messages.length, ...checkpoint);
      throw error;
    }
  }

  async compact(): Promise<boolean> {
    const manager = this.#options.contextManager;
    if (!manager || this.#messages.length <= 1) return false;
    const compacted = await manager.compact(this.#messages, this.#options.systemPrompt);
    if (compacted === this.#messages) return false;
    this.#messages.splice(0, this.#messages.length, ...compacted);
    return true;
  }

  /** 调用模型，流式接收 */
  async #callModel() {
    const stream = this.#options.client.messages.stream(
      {
        model: this.#options.model,
        max_tokens: 8_192,
        system: this.#options.systemPrompt,
        messages: this.#messages,
        tools: this.#options.tools.toAnthropicTools(),
      },
      { signal: this.#controller.signal },
    );

    stream.on('text', (delta) => {
      this.#options.onText?.(delta);
    });

    // finalMessage() 会把流式片段拼装成一条完整的 Message，
    // 包括工具入参的分片 JSON
    return await stream.finalMessage();
  }

  /** 执行一个工具调用，返回 tool_result 块 */
  async #runTool(toolUse: ToolUseBlock): Promise<ToolResultBlockParam> {
    const name = toolUse.name;
    const input = (toolUse.input ?? {}) as Record<string, unknown>;

    this.#options.onToolStart?.(name, input);

    const tool = this.#options.tools.get(name);
    if (!tool) {
      const result: ToolResult = {
        content: `未知工具：${name}。可用工具：${this.#options.tools
          .list()
          .map((t) => t.name)
          .join(', ')}`,
        isError: true,
      };
      this.#options.onToolEnd?.(name, result);
      return this.#toToolResult(toolUse.id, result);
    }

    // 1. 权限检查
    const check = this.#options.permissions?.check(tool, input);
    if (check?.decision === 'deny') {
      const result: ToolResult = {
        content: `操作被拒绝：${check.matched?.reason ?? '权限规则拒绝'}。请换一种做法。`,
        isError: true,
      };
      this.#options.onToolEnd?.(name, result);
      return this.#toToolResult(toolUse.id, result);
    }

    if (check?.decision === 'ask') {
      const allowed = await this.#confirmTool(tool.name, input, check.matched?.reason);
      if (!allowed) {
        const result: ToolResult = {
          content: `用户拒绝了 ${name} 操作。请不要重试同一个操作，先说明你想做什么。`,
          isError: true,
        };
        this.#options.onToolEnd?.(name, result);
        return this.#toToolResult(toolUse.id, result);
      }
    }

    if (this.#controller.signal.aborted) throw new Error('请求已取消');

    // 2. 入参校验
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const result: ToolResult = {
        content: `参数不合法：${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(根)'} — ${issue.message}`)
          .join('; ')}`,
        isError: true,
      };
      this.#options.onToolEnd?.(name, result);
      return this.#toToolResult(toolUse.id, result);
    }

    // 3. 执行
    try {
      const ctx: ToolContext = {
        cwd: this.#options.cwd,
        signal: this.#controller.signal,
        confirm: async (request) => {
          const allowed = await this.#options.onConfirm?.(request);
          return allowed ?? false;
        },
        write: (message) => {
          this.#options.onToolStart?.('__log__', message);
        },
        todos: this.#todos,
        fileReads: this.#fileReads,
      };

      const result = await tool.execute(parsed.data, ctx);
      this.#options.onToolEnd?.(name, result);
      return this.#toToolResult(toolUse.id, result);
    } catch (error) {
      const result: ToolResult = {
        content: `工具执行抛出异常：${(error as Error).message}`,
        isError: true,
      };
      this.#options.onToolEnd?.(name, result);
      return this.#toToolResult(toolUse.id, result);
    }
  }

  async #confirmTool(
    name: string,
    input: Record<string, unknown>,
    reason?: string,
  ): Promise<boolean> {
    if (!this.#options.onConfirm) return false;

    const target =
      typeof input.command === 'string'
        ? input.command
        : typeof input.file_path === 'string'
          ? input.file_path
          : JSON.stringify(input);

    return await this.#options.onConfirm({
      title: `允许执行 ${name}？`,
      detail: reason ?? '该操作会改变系统状态',
      target,
    });
  }

  #toToolResult(
    toolUseId: string,
    result: ToolResult,
  ): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: result.content,
      is_error: result.isError,
    };
  }

  async #maybeCompact(): Promise<void> {
    const manager = this.#options.contextManager;
    if (!manager) return;
    if (!manager.needsCompaction(this.#messages, this.#options.systemPrompt)) return;

    const before = manager.estimate(this.#messages, this.#options.systemPrompt);
    // 注意顺序：先压缩拿到新数组，再整体替换
    const compacted = await manager.compact(this.#messages, this.#options.systemPrompt);
    this.#messages.length = 0;
    this.#messages.push(...compacted);
    const after = manager.estimate(this.#messages, this.#options.systemPrompt);

    this.#options.onToolStart?.(
      '__log__',
      `${paintIf('gray', `[上下文压缩] ${before} → ${after} tokens`)}`,
    );
  }
}

/** 组装工具结果块的类型辅助（仅用于文档示例） */
export type { ContentBlockParam };
export { symbols };
