import { z } from 'zod';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { Tool } from './types.js';

/**
 * Anthropic API 需要的工具描述格式。
 *
 * 注意 `input_schema` 必须是标准 JSON Schema，
 * 这里用 zod v4 的 `toJSONSchema` 从 zod schema 直接派生。
 */
export type AnthropicToolSchema = AnthropicTool;

/**
 * 工具注册表：集中管理所有可用工具，并负责和模型侧对接。
 *
 * 之所以要有这一层：
 * - 模型看到的是「工具的描述」，与「工具的实现」必须解耦
 * - 工具可能来自不同来源（内置 / MCP / 插件），统一在这里装配
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具名重复：${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** 转换成 Anthropic API 期望的工具列表 */
  toAnthropicTools(): AnthropicTool[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.schema, {
        io: 'input',
        // 额外字段一律拒绝，避免模型幻觉出没定义的参数
        override: (ctx) => {
          const schema = ctx.jsonSchema as Record<string, unknown>;
          if (schema.type === 'object') {
            schema.additionalProperties = false;
          }
        },
      }) as unknown as AnthropicTool['input_schema'],
    }));
  }
}
