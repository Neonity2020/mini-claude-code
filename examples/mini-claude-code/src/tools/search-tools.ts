import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { isInside, isSafePath, resolvePath, truncate } from './fs-utils.js';

/** 默认忽略的目录 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__',
]);

/** 递归遍历目录，返回所有文件路径 */
async function walk(root: string, cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      if (IGNORED_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (!isInside(cwd, full)) continue;

      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  await visit(root);
  return files;
}

/**
 * 把 glob 模式（只支持 * 和 **）编译成正则。
 *
 * 不引入完整的 glob 库，是因为教学目标是让大家看清匹配逻辑本身，
 * 而不是学会调 API。
 */
function globToRegExp(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === '*') {
      if (pattern.charAt(i + 1) === '*') {
        regex += '.*';
        i++;
        if (pattern.charAt(i + 1) === '/') i++;
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return new RegExp(`^${regex}$`);
}

const globSchema = z.object({
  pattern: z.string().describe('glob 模式，例如 src/**/*.ts'),
  path: z.string().optional().describe('搜索的起始目录，默认当前工作目录'),
});

/**
 * Glob 工具：按文件名模式查找文件。
 */
export const globTool: Tool<typeof globSchema> = {
  name: 'Glob',
  description:
    '按 glob 模式查找文件，返回匹配到的文件路径列表（按最近修改排序）。' +
    '例如 **/*.ts、src/**/*.{ts,tsx}（本实现仅支持 * 与 **）。',
  schema: globSchema,
  permission: 'allow',
  primaryParam: 'pattern',
  async execute(input, ctx) {
    const searchRoot = resolvePath(ctx.cwd, input.path ?? '.');

    if (!(await isSafePath(ctx.cwd, searchRoot))) {
      return { content: `拒绝搜索工作目录之外的路径：${searchRoot}`, isError: true };
    }

    const files = await walk(searchRoot, ctx.cwd);
    const regex = globToRegExp(input.pattern);

    const matched = files.filter((file) => {
      const relative = path.relative(ctx.cwd, file).split(path.sep).join('/');
      return regex.test(relative) || regex.test(path.basename(file));
    });

    if (matched.length === 0) {
      return { content: `没有匹配 \`${input.pattern}\` 的文件。` };
    }

    // 按最近修改排序，让模型优先看到刚被改过的文件
    const withStat = await Promise.all(
      matched.map(async (file) => ({
        file,
        mtime: await fs.stat(file).then((s) => s.mtimeMs).catch(() => 0),
      })),
    );
    withStat.sort((a, b) => b.mtime - a.mtime);

    const lines = withStat.map(
      ({ file }) => path.relative(ctx.cwd, file).split(path.sep).join('/'),
    );

    return {
      content: `找到 ${lines.length} 个匹配文件：\n${lines.join('\n')}`,
    };
  },
};

const grepSchema = z.object({
  pattern: z.string().describe('正则表达式，例如 function\\s+\\w+'),
  path: z.string().optional().describe('搜索目录，默认当前工作目录'),
  glob: z.string().optional().describe('只搜索匹配该 glob 的文件，例如 *.ts'),
  output_mode: z
    .enum(['files', 'content'])
    .optional()
    .describe('files 只列出文件名，content 给出匹配行及行号，默认 content'),
  head_limit: z.number().int().min(1).optional().describe('最多返回多少条结果，默认 100'),
});

/**
 * Grep 工具：按正则搜索文件内容。
 */
export const grepTool: Tool<typeof grepSchema> = {
  name: 'Grep',
  description:
    '用正则表达式搜索文件内容，返回匹配的文件和行号。' +
    '比 Glob 更适合「找出某个符号在哪里被使用」。',
  schema: grepSchema,
  permission: 'allow',
  primaryParam: 'pattern',
  async execute(input, ctx) {
    const searchRoot = resolvePath(ctx.cwd, input.path ?? '.');

    if (!(await isSafePath(ctx.cwd, searchRoot))) {
      return { content: `拒绝搜索工作目录之外的路径：${searchRoot}`, isError: true };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, 'i');
    } catch (error) {
      return { content: `正则表达式无效：${(error as Error).message}`, isError: true };
    }

    const files = await walk(searchRoot, ctx.cwd);
    const fileRegex = input.glob ? globToRegExp(input.glob) : null;
    const headLimit = input.head_limit ?? 100;

    const results: string[] = [];

    for (const file of files) {
      if (results.length >= headLimit) break;

      if (fileRegex) {
        const relative = path.relative(ctx.cwd, file).split(path.sep).join('/');
        if (!fileRegex.test(relative) && !fileRegex.test(path.basename(file))) continue;
      }

      // 二进制文件跳过，否则会读出乱码
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) continue;

      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!regex.test(line)) continue;

        const relative = path.relative(ctx.cwd, file).split(path.sep).join('/');
        results.push(
          input.output_mode === 'files'
            ? relative
            : `${relative}:${i + 1}:${line.trim().slice(0, 200)}`,
        );

        if (results.length >= headLimit) break;
      }
    }

    if (results.length === 0) {
      return { content: `没有匹配 \`${input.pattern}\` 的内容。` };
    }

    const output = truncate(results.join('\n'), 20_000);
    return {
      content: `找到 ${results.length} 条匹配：\n${output}`,
    };
  },
};
