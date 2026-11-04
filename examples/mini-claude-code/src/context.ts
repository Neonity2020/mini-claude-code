import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { estimateMessagesTokens } from './llm.js';

export interface ContextManagerOptions {
  /** 上下文窗口大小 */
  maxTokens: number;
  /** 超过这个比例就触发压缩 */
  compactThreshold: number;
  /** 压缩时保留最近多少条消息不动 */
  keepRecentMessages: number;
  client?: Anthropic;
  model?: string;
}

/**
 * 上下文管理器。
 *
 * Agent 的能力上限，实际上就是上下文窗口的上限。
 * 长任务会不断累积历史，最终撑爆窗口，所以必须有一条
 * 「把旧信息压缩成摘要」的通路。
 */
export class ContextManager {
  readonly #options: ContextManagerOptions;

  constructor(options: Partial<ContextManagerOptions> = {}) {
    this.#options = {
      maxTokens: options.maxTokens ?? 200_000,
      compactThreshold: options.compactThreshold ?? 0.7,
      keepRecentMessages: options.keepRecentMessages ?? 10,
      client: options.client,
      model: options.model,
    };
  }

  /** 当前预算的 token 上限 */
  get limit(): number {
    return Math.floor(this.#options.maxTokens * this.#options.compactThreshold);
  }

  /** 估算当前上下文的 token 占用 */
  estimate(messages: MessageParam[], system?: string): number {
    return estimateMessagesTokens(messages, system);
  }

  /** 是否需要压缩 */
  needsCompaction(messages: MessageParam[], system?: string): boolean {
    if (messages.length <= this.#options.keepRecentMessages) return false;
    return this.estimate(messages, system) > this.limit;
  }

  /**
   * 压缩上下文。
   *
   * 策略：把较早的消息交给模型总结成一段摘要，
   * 保留最近 N 条原始消息不动（保证近期的精确细节不丢失）。
   */
  async compact(messages: MessageParam[], system?: string): Promise<MessageParam[]> {
    const keep = this.#options.keepRecentMessages;
    if (messages.length <= keep) return messages;

    let boundary = messages.length - keep;
    // tool_result 必须紧跟包含对应 tool_use 的 assistant 消息。
    const first = messages[boundary];
    if (first?.role === 'user' && Array.isArray(first.content) &&
        first.content.some((block) => block.type === 'tool_result')) boundary--;
    const older = messages.slice(0, boundary);
    const recent = messages.slice(boundary);

    const summary = await this.#summarize(older);

    const compacted: MessageParam[] = [
      {
        role: 'user',
        content: `[上下文摘要] 以下是本次会话早期内容的摘要，请以此为准继续工作：\n\n${summary}`,
      },
      ...recent,
    ];

    return compacted;
  }

  async #summarize(messages: MessageParam[]): Promise<string> {
    const transcript = messages
      .map((message) => {
        const role = message.role === 'assistant' ? '助手' : '用户';
        const content =
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
        return `### ${role}\n${content}`;
      })
      .join('\n\n');

    // 没有客户端（离线测试）时，退化成截断
    if (!this.#options.client || !this.#options.model) {
      return transcript.slice(0, 4_000);
    }

    const response = await this.#options.client.messages.create({
      model: this.#options.model,
      max_tokens: 1_000,
      system:
        '你是一个会话压缩器。把给定的对话历史压缩成一份紧凑的摘要，' +
        '保留：已完成的任务、关键决策、涉及的文件路径、尚未完成的事项、用户明确的偏好。' +
        '丢弃寒暄和冗余过程描述。只输出摘要正文。',
      messages: [
        {
          role: 'user',
          content: `请压缩以下对话历史：\n\n${transcript.slice(0, 100_000)}`,
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return text.trim() || transcript.slice(0, 4_000);
  }
}
