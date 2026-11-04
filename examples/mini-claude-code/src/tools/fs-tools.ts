import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { fingerprint, isSafePath, normalizeNewlines, readFileSafe, resolvePath } from './fs-utils.js';

const schema = z.object({
  file_path: z.string().describe('要读取的文件的绝对路径或相对工作目录的路径'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('起始行号，从 1 开始。不填则从头读取'),
  limit: z.number().int().min(1).optional().describe('最多读取多少行'),
});

/**
 * Read 工具：读取文件内容。
 *
 * 两个容易踩的坑：
 * 1. 绝对路径 + 越界检查，防止读到工作目录之外
 * 2. 大文件要截断，否则一次读取就能吃光上下文
 */
export const readTool: Tool<typeof schema> = {
  name: 'Read',
  description:
    '读取一个文件的内容，返回带行号的文本。适用于查看源码、配置文件、日志。' +
    '文件很大时用 offset/limit 分段读取。',
  schema,
  permission: 'allow',
  primaryParam: 'file_path',
  async execute(input, ctx) {
    const filePath = resolvePath(ctx.cwd, input.file_path);

    if (!(await isSafePath(ctx.cwd, filePath))) {
      return { content: `拒绝读取工作目录之外的文件：${filePath}`, isError: true };
    }

    const raw = await readFileSafe(filePath);
    const content = normalizeNewlines(raw);
    const allLines = content.split('\n');

    const start = (input.offset ?? 1) - 1;
    const end = input.limit ? start + input.limit : allLines.length;
    const selected = allLines.slice(start, end);

    if (selected.length === 0) {
      return {
        content: `文件 ${input.file_path} 一共 ${allLines.length} 行，offset=${input.offset ?? 1} 超出范围。`,
        isError: true,
      };
    }

    // 记录指纹，供 Edit 工具做「读后再改」检查
    ctx.fileReads.markRead(filePath, await fingerprint(content));

    const body = selected
      .map((line, index) => `${String(start + index + 1).padStart(6)}\t${line}`)
      .join('\n');

    const truncated = end < allLines.length;
    const suffix = truncated
      ? `\n\n[文件共有 ${allLines.length} 行，已读取到第 ${end} 行]`
      : '';

    return { content: body + suffix };
  },
};

/**
 * Write 工具：整体写入文件（不存在则创建）。
 */
const writeSchema = z.object({
  file_path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('文件的完整新内容'),
});

export const writeTool: Tool<typeof writeSchema> = {
  name: 'Write',
  description: '把给定的完整内容写入文件。文件不存在会创建，存在则整体覆盖。',
  schema: writeSchema,
  permission: 'ask',
  primaryParam: 'file_path',
  async execute(input, ctx) {
    const filePath = resolvePath(ctx.cwd, input.file_path);

    if (!(await isSafePath(ctx.cwd, filePath))) {
      return { content: `拒绝写入工作目录之外的文件：${filePath}`, isError: true };
    }

    const content = normalizeNewlines(input.content);
    const existed = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');

    ctx.fileReads.markRead(filePath, await fingerprint(content));

    const lines = content.split('\n').length;
    return {
      content: `${existed ? '已覆盖' : '已创建'} ${input.file_path}（${lines} 行，${content.length} 字符）。`,
    };
  },
};

/**
 * Edit 工具：把一段精确文本替换成另一段。
 *
 * 相比 Write，Edit 的好处是改动最小、模型不容易手滑重写整个文件。
 * 约束：old_string 必须在文件中唯一出现，否则无法确定改哪一处。
 */
const editSchema = z.object({
  file_path: z.string().describe('要编辑的文件路径'),
  old_string: z.string().describe('要被替换的原文，必须在文件中唯一出现'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('是否替换所有出现位置，默认 false'),
});

export const editTool: Tool<typeof editSchema> = {
  name: 'Edit',
  description:
    '在文件中做精确字符串替换。old_string 必须在文件里唯一出现（除非 replace_all 为 true）。' +
    '用于小范围改动，不要用它整体重写文件。',
  schema: editSchema,
  permission: 'ask',
  primaryParam: 'file_path',
  async execute(input, ctx) {
    const filePath = resolvePath(ctx.cwd, input.file_path);

    if (!(await isSafePath(ctx.cwd, filePath))) {
      return { content: `拒绝编辑工作目录之外的文件：${filePath}`, isError: true };
    }

    const original = normalizeNewlines(await readFileSafe(filePath));

    if (!original.includes(input.old_string)) {
      return {
        content: `未找到要替换的内容。请确认 old_string 与文件中的内容逐字符一致。文件路径：${input.file_path}`,
        isError: true,
      };
    }

    const occurrences = original.split(input.old_string).length - 1;
    if (occurrences > 1 && !input.replace_all) {
      return {
        content:
          `old_string 在 ${input.file_path} 中出现了 ${occurrences} 次，无法确定改哪一处。` +
          '请提供更长的唯一片段，或者设置 replace_all=true。',
        isError: true,
      };
    }

    // 读-改-写一致性检查：模型可能基于过期的文件内容做修改
    if (ctx.fileReads.wasRead(filePath)) {
      const current = await fingerprint(original);
      if (ctx.fileReads.hasChanged(filePath, current)) {
        return {
          content:
            `文件 ${input.file_path} 在你上次读取之后发生了变化。请重新读取该文件，再进行修改。`,
          isError: true,
        };
      }
    }

    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string);

    await fs.writeFile(filePath, updated, 'utf8');
    ctx.fileReads.markRead(filePath, await fingerprint(updated));

    return { content: `已修改 ${input.file_path}。` };
  },
};
