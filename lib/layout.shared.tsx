import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold tracking-tight">
          {appName}
          <span className="ml-2 rounded-md bg-fd-primary/10 px-1.5 py-0.5 text-xs font-normal text-fd-primary">
            教程
          </span>
        </span>
      ),
      url: '/',
    },
    links: [
      {
        text: '文档',
        url: '/docs',
        active: 'nested-url',
      },
    ],
  };
}
