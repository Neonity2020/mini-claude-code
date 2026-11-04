#!/usr/bin/env node
/**
 * 站内链接检查：把 content/docs 下所有 MDX 里出现的 /docs/... 链接
 * 与实际存在的页面路径比对，找出死链。
 *
 * 用法：node scripts/check-links.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DOCS_DIR = path.join(process.cwd(), 'content', 'docs');

/** 收集所有 mdx 文件 */
function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith('.mdx')) out.push(full);
  }
  return out;
}

/** 页面路径集合，例如 /docs/core/agent-loop */
const pages = new Set(['/docs']);
for (const file of collect(DOCS_DIR)) {
  const slug = path
    .relative(DOCS_DIR, file)
    .replace(/\.mdx$/, '')
    .split(path.sep)
    .join('/');
  pages.add(`/docs/${slug}`);
}

const problems = [];
let checked = 0;

for (const file of collect(DOCS_DIR)) {
  const content = fs.readFileSync(file, 'utf8');
  const relative = path.relative(process.cwd(), file);

  // 匹配 href="/docs/..." 与 markdown 链接 [x](/docs/...)
  const patterns = [/href=["']([^"']+)["']/g, /\]\(\/docs[^)]*\)/g];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      const href = raw.replace(/^\]\(/, '').replace(/\)$/, '');
      if (!href.startsWith('/docs')) continue;

      checked++;

      const target = href.split('#')[0].split('?')[0];
      if (target === '/docs') continue;

      if (!pages.has(target)) {
        problems.push(`${relative} -> ${href}`);
      }
    }
  }
}

console.log(`检查了 ${checked} 个站内链接，覆盖 ${pages.size} 个页面`);
if (problems.length > 0) {
  console.error(`\n发现 ${problems.length} 个死链：`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('没有死链 ✅');
