import Anthropic from '@anthropic-ai/sdk';
import { createOpenAIClient } from './openai.js';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function getProvider(): 'mimo' | 'anthropic' | 'openai' {
  const value = process.env.LLM_PROVIDER ?? 'mimo';
  if (value !== 'mimo' && value !== 'anthropic' && value !== 'openai') throw new Error('LLM_PROVIDER 必须是 mimo、anthropic 或 openai。');
  return value;
}

export function getModel(): string {
  const provider = getProvider();
  return provider === 'mimo' ? (process.env.MIMO_MODEL ?? 'mimo-v2.6-flash').replace(/^mimo\//, '')
    : provider === 'openai' ? (process.env.OPENAI_MODEL ?? 'gpt-4.1') : (process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL);
}

/** 创建所选提供商的客户端 */
export function createClient(): Anthropic {
  const provider = getProvider();
  if (provider === 'mimo') {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) throw new Error('缺少 MIMO_API_KEY。请设置 MiMo Token Plan 订阅密钥（tp-...）。');
    return createOpenAIClient({ apiKey, baseURL: process.env.MIMO_BASE_URL ?? 'https://token-plan-cn.xiaomimimo.com/v1' });
  }
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('缺少 OPENAI_API_KEY 环境变量。');
    return createOpenAIClient({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      '缺少 ANTHROPIC_API_KEY 环境变量。\n' +
        '请先执行：export ANTHROPIC_API_KEY=sk-ant-xxx',
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * 粗略估算 token 数量。
 *
 * 真实 token 数可以用 count_tokens 接口精确查询，但那是异步的、
 * 要额外一次网络请求，不适合放在每轮循环里做预算判断。
 * 这里用「字符数 / 3.6」估算——英文文本的经验值，误差在 15% 以内，
 * 对「该不该压缩」这种二值决策完全够用。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** 估算一组消息的 token 数 */
export function estimateMessagesTokens(
  messages: unknown[],
  system?: string,
): number {
  const serialized = JSON.stringify(messages);
  return estimateTokens(serialized) + (system ? estimateTokens(system) : 0);
}
