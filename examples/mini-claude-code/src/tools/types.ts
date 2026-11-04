import type { z } from 'zod';

/**
 * 一次工具执行的结果。
 *
 * `content` 会原样回填给模型，所以它既是「给人看的日志」，
 * 也是「给模型看的观察结果」——两者必须同时成立。
 */
export interface ToolResult {
  content: string;
  /** 模型看到 isError 时，知道这次调用失败了，可以自行重试或换策略 */
  isError?: boolean;
}

/** 权限决策 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** 工具需要用户确认时，描述「要做什么」 */
export interface ConfirmRequest {
  title: string;
  detail: string;
  /** 受影响的命令 / 文件路径 */
  target: string;
}

/** 待办事项，供 TodoWrite 工具读写 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** 记录「模型读过哪些文件」，用于 read-before-edit 检查 */
export interface FileReadTracker {
  /** @param fingerprint 读取时的文件内容指纹 */
  markRead(path: string, fingerprint: string): void;
  /** @returns 文件自上次读取后是否发生变化 */
  hasChanged(path: string, fingerprint: string): boolean;
  wasRead(path: string): boolean;
}

/**
 * 工具在执行期间能拿到的全部上下文。
 *
 * 设计要点：工具本身不碰终端、不管权限、不管会话，
 * 它只描述「输入 -> 输出」，所有副作用都通过 ctx 走。
 */
export interface ToolContext {
  /** 工作目录，所有相对路径都基于它解析 */
  cwd: string;
  /** 取消信号，用户按 Ctrl+C 时透传到子进程 */
  signal: AbortSignal;
  /** 询问用户是否允许执行 */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** 往终端输出一行辅助信息 */
  write(message: string): void;
  /** 待办清单 */
  todos: TodoItem[];
  /** 文件读取追踪 */
  fileReads: FileReadTracker;
}

/**
 * 一个工具的定义。
 *
 * `Schema` 用 zod 描述，由它派生出两样东西：
 * 1. 给模型看的 JSON Schema（`z.toJSONSchema`）
 * 2. 服务端的运行时校验（`schema.parse`）
 *
 * 这样 schema 只有一份，不会出现「文档写的和实际校验的不一致」。
 */
export interface Tool<Schema extends z.ZodType = z.ZodType> {
  /** 工具名，模型用它来调用，必须唯一且稳定 */
  name: string;
  /** 工具描述——这是模型选择工具的主要依据，写清楚比写简短更重要 */
  description: string;
  /** 输入 schema */
  schema: Schema;
  /** 默认权限策略，具体是否放行还要过 PermissionManager */
  permission: PermissionDecision;
  /**
   * 工具的主参数名，用于权限规则匹配
   * 例如 Bash 的 command、Write 的 file_path
   */
  primaryParam?: string;
  /** 执行工具 */
  execute(input: z.infer<Schema>, ctx: ToolContext): Promise<ToolResult>;
}
