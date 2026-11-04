import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types.js';
import { isInside, resolvePath, truncate } from './fs-utils.js';

const bashSchema = z.object({
  command: z.string().describe('要在工作目录中执行的 shell 命令'),
  description: z.string().optional().describe('用一句话说明这个命令要做什么，用于日志展示'),
  timeout: z.number().int().min(1).max(600_000).optional().describe('超时时间（毫秒），默认 120000'),
});

/**
 * Bash 工具：执行 shell 命令。
 *
 * 这是整个 agent 里风险最高的一个工具，因此配套了三重防护：
 * 1. PermissionManager 拦截危险命令（rm -rf /、sudo 等）
 * 2. 超时 + 输出截断，防止一条命令卡死或刷屏
 * 3. 始终以 cwd 为工作目录执行
 */
export const bashTool: Tool<typeof bashSchema> = {
  name: 'Bash',
  description:
    '在工作目录中执行一条 shell 命令，返回 stdout 和 stderr。' +
    '适用于 git、npm、构建、测试等操作。命令输出会被截断。',
  schema: bashSchema,
  permission: 'ask',
  primaryParam: 'command',
  async execute(input, ctx) {
    const timeout = input.timeout ?? 120_000;
    const workdir = resolvePath(ctx.cwd, '.');

    if (!isInside(ctx.cwd, workdir)) {
      return { content: `拒绝在 ${workdir} 之外执行命令。`, isError: true };
    }

    return await new Promise((resolve) => {
      const child = spawn('bash', ['-lc', input.command], {
        cwd: workdir,
        signal: ctx.signal,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ content: `命令启动失败：${error.message}`, isError: true });
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({
            content: `命令超时（${timeout}ms）被终止。\n${truncate(stdout, 5_000)}`,
            isError: true,
          });
          return;
        }

        const parts: string[] = [];
        if (stdout.trim()) parts.push(truncate(stdout, 20_000).trimEnd());
        if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr, 10_000).trimEnd()}`);
        if (parts.length === 0) parts.push('(命令没有产生输出)');

        parts.push(`[exit code: ${code ?? 'null'}]`);

        resolve({
          content: parts.join('\n\n'),
          isError: code !== 0,
        });
      });
    });
  },
};

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe('任务描述，使用祈使句'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
        activeForm: z.string().optional().describe('进行中的动词短语，例如「正在读取文件」'),
      }),
    )
    .describe('完整的待办清单（覆盖式的，不是追加）'),
});

/**
 * TodoWrite 工具：维护任务清单。
 *
 * 为什么需要它：让模型把多步任务显式地拆出来，
 * 人能实时看到进度，模型自己也不容易漏步骤。
 */
export const todoTool: Tool<typeof todoSchema> = {
  name: 'TodoWrite',
  description:
    '创建或更新待办清单，用于跟踪多步骤任务的进度。' +
    '每次调用传入完整清单，不是增量。同一时刻最多一个任务处于 in_progress。',
  schema: todoSchema,
  permission: 'allow',
  primaryParam: 'todos',
  async execute(input, ctx) {
    const inProgress = input.todos.filter((todo) => todo.status === 'in_progress');

    if (inProgress.length > 1) {
      return {
        content: `有 ${inProgress.length} 个任务同时处于 in_progress，请只保留一个。`,
        isError: true,
      };
    }

    ctx.todos.length = 0;
    ctx.todos.push(...input.todos);

    const rendered = input.todos
      .map((todo) => {
        const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' ';
        return `[${mark}] ${todo.content}`;
      })
      .join('\n');

    return { content: `待办清单已更新：\n${rendered}` };
  },
};
