import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 把相对路径解析成基于 cwd 的绝对路径 */
export function resolvePath(cwd: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

/**
 * 判断 target 是否位于 root 之内。
 *
 * 这是「沙箱」的第一道防线：所有读写操作都不允许逃出工作目录。
 * 注意要用 path.relative 判断而不是字符串 startsWith，
 * 否则 /home/user-2 会被误判成在 /home/user 内部。
 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 拒绝路径中任何符号链接，包括尚未创建的目标的已有父目录。 */
export async function isSafePath(root: string, target: string): Promise<boolean> {
  if (!isInside(root, target)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

/** 读取文件内容并计算指纹，用于检测「读完之后文件被改了」 */
export async function fingerprint(content: string): Promise<string> {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface FileReadRecord {
  fingerprint: string;
  readAt: number;
}

/** 内存版的文件读取追踪器 */
export class FileReadTrackerImpl {
  readonly #records = new Map<string, FileReadRecord>();

  markRead(filePath: string, fileFingerprint: string): void {
    this.#records.set(filePath, { fingerprint: fileFingerprint, readAt: Date.now() });
  }

  wasRead(filePath: string): boolean {
    return this.#records.has(filePath);
  }

  hasChanged(filePath: string, fileFingerprint: string): boolean {
    const record = this.#records.get(filePath);
    if (!record) return true;
    return record.fingerprint !== fileFingerprint;
  }
}

/** 读取文件，带上清晰的错误信息 */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`文件不存在：${filePath}`);
    if (code === 'EISDIR') throw new Error(`这是一个目录，不是文件：${filePath}`);
    if (code === 'EACCES') throw new Error(`没有读取权限：${filePath}`);
    throw error;
  }
}

/** 统一以 LF 结尾，避免模型产生看不见的差异 */
export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * 截断超长输出。
 *
 * 为什么要截断：一次 grep 命中可能产生几万行，全部塞回上下文会直接
 * 把窗口撑爆，而且对模型几乎没有增量价值。截断时保留头尾，
 * 因为头尾通常才是「结论所在」。
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const headLength = Math.floor(maxLength * 0.6);
  const tailLength = maxLength - headLength;
  const omitted = text.length - headLength - tailLength;

  return [
    text.slice(0, headLength),
    `\n... [已省略 ${omitted.toLocaleString('en-US')} 字符] ...\n`,
    text.slice(text.length - tailLength),
  ].join('');
}
