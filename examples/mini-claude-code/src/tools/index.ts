import { bashTool, todoTool } from './bash-tool.js';
import { editTool, readTool, writeTool } from './fs-tools.js';
import { globTool, grepTool } from './search-tools.js';
import type { Tool } from './types.js';

/**
 * 全部内置工具。
 *
 * 顺序不重要（模型是靠描述选择工具的），
 * 但这里集中列出来，方便你「删掉一个试试」——
 * 少一个工具，模型的行为会立刻变化，这是理解工具设计最快的方式。
 */
export const BUILTIN_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  todoTool,
];

export { bashTool, todoTool } from './bash-tool.js';
export { editTool, readTool, writeTool } from './fs-tools.js';
export { globTool, grepTool } from './search-tools.js';
export { ToolRegistry } from './registry.js';
export type {
  ConfirmRequest,
  FileReadTracker,
  PermissionDecision,
  TodoItem,
  Tool,
  ToolContext,
  ToolResult,
} from './types.js';
