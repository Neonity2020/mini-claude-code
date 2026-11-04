#!/usr/bin/env node
/**
 * 文档 ↔ 源码漂移审计。
 *
 * 教程的硬性约定是「代码片段必须与 examples/mini-claude-code/src 下的真实源码
 * 逐字一致」。本脚本把每个 MDX 里带 title="src/..." 的代码块抽出来，
 * 去源文件里找连续子序列，匹配不上就报告。
 *
 * 用法：node scripts/check-snippets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOCS = path.join(ROOT, 'content', 'docs');
const PKG = path.join(ROOT, 'examples', 'mini-claude-code');

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** 去掉每行公共缩进，便于比较 */
function dedent(lines) {
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return [];
  const indent = Math.min(
    ...meaningful.map((line) => line.match(/^ */)[0].length),
  );
  return lines.map((line) => (line.trim().length ? line.slice(indent) : line.trim()));
}

/**
 * 按「去掉行首空白」的内容比对。
 *
 * 为什么要去空白：文档里的代码块是从源文件中间摘出来的（类体内部多两格缩进），
 * 而源文件整体缩进是 0。直接比对缩进会把所有类内代码误判成漂移。
 * 去空白后比对的是真正的内容一致性。
 */
function normalize(lines) {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 块里可能有「// ...」省略标记，把它切成若干连续片段分别匹配 */
function splitOnEllipsis(lines) {
  const segments = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*\/\/\s*\.\.\.\s*$/.test(line)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function findSubsequence(haystack, needle) {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 找出最接近的匹配点，报告第一处不一致。
 *
 * 没有这个信息，开发者只知道「对不上」，不知道差在哪一行。
 */
function findClosest(haystack, needle) {
  let best = { score: -1, index: -1, line: -1 };
  for (let i = 0; i < haystack.length; i++) {
    let j = 0;
    while (i + j < haystack.length && j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j > best.score) best = { score: j, index: i, line: j };
  }
  return best;
}

/**
 * 把代码块标题解析成示例包内的相对路径。
 *
 * 文档里的标题写法不统一：`src/llm.ts`、`test/tools.test.ts`、
 * `examples/mini-claude-code/src/llm.ts` 都出现过。这里统一成
 * 「相对 examples/mini-claude-code 的路径」。
 */
function resolveTitle(title) {
  const cleaned = title
    .replace(/（[^）]*）\s*$/, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
  const marker = cleaned.indexOf('src/');
  if (marker === -1) return null;
  return cleaned.slice(marker);
}

const sourceFiles = new Map();
for (const file of walk(PKG, (f) => f.endsWith('.ts'))) {
  const rel = path.relative(PKG, file).split(path.sep).join('/');
  sourceFiles.set(rel, normalize(fs.readFileSync(file, 'utf8').split('\n')));
}

const report = [];
let checked = 0;

/**
 * 代码块标题里带这些标记的，是「示意 / 示例 / 伪代码」，
 * 本来就不该逐字等于源码，跳过校验。
 */
const ILLUSTRATIVE = /示意|伪代码|示例|本章新增|pseudo/i;

for (const file of walk(DOCS, (f) => f.endsWith('.mdx'))) {
  const content = fs.readFileSync(file, 'utf8');
  const relDoc = path.relative(ROOT, file);

  // 匹配 ```ts title="src/xxx.ts" ... ```
  const pattern = /```(\w+)\s+title="([^"]+)"\s*\n([\s\S]*?)```/g;

  for (const match of content.matchAll(pattern)) {
    const [, , title, body] = match;
    const srcRel = resolveTitle(title);
    if (!srcRel) continue;
    if (ILLUSTRATIVE.test(title)) {
      report.push({ kind: 'illustrative', doc: relDoc, title, detail: '示意/示例代码，不做逐字校验' });
      continue;
    }

    checked++;

    const source = sourceFiles.get(srcRel);

    if (!source) {
      report.push({ kind: 'new-module', doc: relDoc, title, detail: '源文件不存在（本章新增模块）' });
      continue;
    }
    const lines = normalize(body.split('\n'));
    const segments = splitOnEllipsis(lines).filter((s) => s.length > 0);

    const missing = segments.filter((segment) => !findSubsequence(source, segment));

    if (missing.length > 0) {
      const segment = missing[0];
      const closest = findClosest(source, segment);
      const sourceLine = closest.index + closest.line;
      report.push({
        kind: 'drift',
        doc: relDoc,
        title,
        detail:
          `${missing.length}/${segments.length} 段匹配不上。\n` +
          `      文档第 ${closest.line + 1} 行：${segment[closest.line] ?? '(末尾)'}\n` +
          `      源码对应处：${source[sourceLine] ?? '(文件末尾)'}`,
      });
    }
  }
}

console.log(`审计了 ${checked} 个带 src/ 标题的代码块`);
const drift = report.filter((r) => r.kind === 'drift');
const fresh = report.filter((r) => r.kind === 'new-module');

console.log(`\n漂移 ${drift.length} 个：`);
for (const item of drift) {
  console.log(`  ✗ ${item.doc}  [${item.title}]`);
  console.log(`      ${item.detail}`);
}
console.log(`\n本章新增模块（无对应源文件）${fresh.length} 个：`);
for (const item of fresh) {
  console.log(`  · ${item.doc}  [${item.title}]`);
}

const illustrative = report.filter((r) => r.kind === 'illustrative');
console.log(`\n示意/示例代码块（不校验）${illustrative.length} 个`);

process.exit(drift.length > 0 ? 1 : 0);
