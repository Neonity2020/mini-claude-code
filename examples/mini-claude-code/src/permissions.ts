import type { PermissionDecision, Tool } from './tools/types.js';

/** 一条权限规则 */
export interface PermissionRule {
  /** 工具名，`*` 表示全部 */
  tool: string;
  /**
   * 主参数的正则。留空表示匹配该工具的任意调用。
   * 例如 Bash + "rm -rf" 表示只有 rm -rf 类命令命中这条规则。
   */
  pattern?: string;
  decision: PermissionDecision;
  /** 命中时给用户看的原因 */
  reason?: string;
}

export interface PermissionCheck {
  decision: PermissionDecision;
  matched?: PermissionRule;
}

/**
 * 默认规则集。
 *
 * 排序很重要：**从上到下第一条命中的规则生效**。
 * 这样「危险命令」必须排在「Bash 一律放行」之前。
 */
export const DEFAULT_RULES: PermissionRule[] = [
  // 1. 绝对禁止：不可逆且影响系统级
  {
    tool: 'Bash',
    pattern: 'rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)*(/|~|\\*)',
    decision: 'deny',
    reason: '该命令会递归删除根目录或家目录，属于不可逆的破坏性操作',
  },
  {
    tool: 'Bash',
    pattern: '\\b(mkfs|dd\\s+if=|shutdown|reboot|halt)\\b',
    decision: 'deny',
    reason: '该命令会破坏磁盘或系统状态',
  },
  {
    tool: 'Bash',
    pattern: '\\bsudo\\b|\\bsu\\b',
    decision: 'deny',
    reason: '不允许提权执行',
  },
  {
    tool: 'Bash',
    pattern: ':\\(\\)\\s*\\{|\\bchmod\\s+777\\b',
    decision: 'deny',
    reason: '疑似 fork 炸弹或过度放宽权限',
  },

  // 3. 其余 Bash：需要确认
  {
    tool: 'Bash',
    decision: 'ask',
    reason: '该命令会改变系统状态',
  },

  // 4. 写文件：需要确认
  { tool: 'Write', decision: 'ask', reason: '将写入或覆盖文件' },
  { tool: 'Edit', decision: 'ask', reason: '将修改文件内容' },

  // 5. 只读工具：直接放行
  { tool: 'Read', decision: 'allow', reason: '只读操作' },
  { tool: 'Glob', decision: 'allow', reason: '只读操作' },
  { tool: 'Grep', decision: 'allow', reason: '只读操作' },
  { tool: 'TodoWrite', decision: 'allow', reason: '只操作会话状态' },
];

/**
 * 权限管理器。
 *
 * 职责：回答「这次工具调用是放行、询问还是拒绝」。
 * 它不关心工具怎么实现，只做匹配和决策。
 */
export class PermissionManager {
  readonly #rules: PermissionRule[];

  constructor(rules: PermissionRule[] = DEFAULT_RULES) {
    this.#rules = rules;
  }

  addRule(rule: PermissionRule): this {
    // 新规则插到最前面，保证用户自定义规则优先生效
    this.#rules.unshift(rule);
    return this;
  }

  /**
   * 检查一次工具调用。
   *
   * @param tool 工具定义
   * @param input 工具输入
   */
  check(tool: Tool, input: Record<string, unknown>): PermissionCheck {
    const primaryValue =
      tool.primaryParam && typeof input[tool.primaryParam] === 'string'
        ? (input[tool.primaryParam] as string)
        : undefined;

    for (const rule of this.#rules) {
      if (rule.tool !== '*' && rule.tool !== tool.name) continue;

      if (rule.pattern) {
        if (!primaryValue) continue;
        if (!new RegExp(rule.pattern, 'i').test(primaryValue)) continue;
      }

      return { decision: rule.decision, matched: rule };
    }

    // 没有规则命中时，退回工具自己声明的默认策略
    return { decision: tool.permission };
  }
}
