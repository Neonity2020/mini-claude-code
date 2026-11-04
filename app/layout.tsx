import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: {
    default: 'Mini Claude Code — 从零手写一个终端编程助手',
    template: '%s | Mini Claude Code',
  },
  description:
    '22 章中文教程，从零用 TypeScript 手写一个 Claude Code：agent 循环、工具系统、上下文压缩、权限模型，全部代码可运行。',
  keywords: ['Claude Code', 'Agent', 'TypeScript', 'Anthropic', 'AI 编程助手', '教程'],
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    title: 'Mini Claude Code — 从零手写一个终端编程助手',
    description:
      '22 章中文教程，用 TypeScript 手写一个 Claude Code：agent 循环、工具系统、上下文压缩、权限模型。',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
