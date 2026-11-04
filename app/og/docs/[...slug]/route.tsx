import fs from 'node:fs/promises';
import path from 'node:path';
import { source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { generateOGImage } from 'fumadocs-ui/og';
import { appName, getPageImageUrl } from '@/lib/shared';

export const revalidate = false;

/**
 * OG 图片里的标题是中文，必须自带 CJK 字体。
 *
 * `next/og` 自带的默认字体只覆盖拉丁字符，遇到中文会去 Google Fonts
 * 动态拉取——在网络受限的环境里这一步会失败，标题直接变成豆腐块。
 * 所以我们从本地读一份 Noto Sans SC 塞进去。
 */
const FONT_PATH = path.join(
  process.cwd(),
  'node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff',
);

async function loadFonts() {
  try {
    const data = await fs.readFile(FONT_PATH);
    return [
      {
        name: 'Noto Sans SC',
        data,
        style: 'normal' as const,
        weight: 400 as const,
      },
    ];
  } catch {
    // 字体缺失时退回 next/og 默认字体，不让 OG 图片生成直接失败
    return undefined;
  }
}

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: appName,
    primaryColor: 'rgba(217, 119, 87, 0.85)',
    primaryTextColor: 'rgb(217, 119, 87)',
    fonts: await loadFonts(),
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
