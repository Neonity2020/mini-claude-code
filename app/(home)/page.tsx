import Link from 'next/link';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Card, Cards } from 'fumadocs-ui/components/card';

const ctaClass = (variant: 'primary' | 'outline') =>
  `${buttonVariants({ variant })} px-5 py-2.5 text-base`;

const AGENT_LOOP = `while (true) {
  const message = await callModel();

  // 模型不再要求调工具 -> 任务结束
  if (message.stop_reason !== 'tool_use') break;

  // 执行工具，把结果作为 user 消息喂回去
  const results = await runTools(message);
  messages.push({ role: 'user', content: results });
}`;

const FEATURES = [
  {
    title: '核心循环',
    description: '从零手写 agent loop，不依赖任何 Agent 框架，只用 Anthropic Messages API。',
    href: '/docs/core/agent-loop',
  },
  {
    title: '工具系统',
    description: '用 zod 单一来源地生成 JSON Schema，做参数校验、权限判定与沙箱隔离。',
    href: '/docs/tools/schema',
  },
  {
    title: '上下文工程',
    description: '窗口预算、历史压缩、读后写校验——让长任务不撑爆上下文。',
    href: '/docs/engineering/context',
  },
  {
    title: '权限与安全',
    description: '规则化的权限决策，危险命令拦截，写操作确认，沙箱目录边界。',
    href: '/docs/engineering/permissions',
  },
  {
    title: '子代理',
    description: '让子任务在独立上下文里跑，主上下文只收摘要，避免上下文爆炸。',
    href: '/docs/advanced/subagents',
  },
  {
    title: '多模型接入',
    description: '一套 Anthropic 协议作内层接口，背后接住 Anthropic、OpenAI 与兼容服务。',
    href: '/docs/core/providers',
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-16 sm:py-24">
        {/* Hero */}
        <section className="text-center">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-muted px-3 py-1 text-xs text-fd-muted-foreground">
            <span className="size-1.5 rounded-full bg-fd-primary" />
            TypeScript · 零框架依赖 · 可运行
          </p>

          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            自己动手写一个 <span className="mcc-gradient">Claude Code</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-fd-muted-foreground sm:text-lg">
            22 章从零实现一个终端里的编程助手。不用 Agent SDK，只用最朴素的
            Messages API，把 agent loop、工具系统、上下文压缩、权限控制一层层搭出来——
            每一行代码你都能解释清楚。
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/docs" className={ctaClass('primary')}>
              开始阅读
            </Link>
            <Link href="/docs/getting-started/setup" className={ctaClass('outline')}>
              快速上手
            </Link>
          </div>
        </section>

        {/* 核心循环代码 */}
        <section className="mt-16">
          <div className="mcc-terminal">
            <div className="mcc-terminal-bar">
              <span className="mcc-dot bg-red-400/80" />
              <span className="mcc-dot bg-yellow-400/80" />
              <span className="mcc-dot bg-green-400/80" />
              <span className="ml-2 font-mono text-xs text-white/50">
                src/agent.ts — 整个 agent 的核心
              </span>
            </div>
            <pre className="mcc-terminal-body overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-zinc-200">
              <code>{AGENT_LOOP}</code>
            </pre>
          </div>
          <p className="mt-4 text-center text-sm text-fd-muted-foreground">
            就这么多。剩下的细节——工具怎么描述、参数怎么校验、权限怎么拦、
            上下文满了怎么办——都是在这个循环上长出来的。
          </p>
        </section>

        {/* 特性卡片 */}
        <section className="mt-20">
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            你会学到什么
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-sm text-fd-muted-foreground">
            不是罗列 API，而是理解一个 coding agent 为什么这样设计。
          </p>

          <Cards className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card
                key={feature.title}
                title={feature.title}
                description={feature.description}
                href={feature.href}
              />
            ))}
          </Cards>
        </section>

        {/* 学习路径 */}
        <section className="mt-20 rounded-xl border border-fd-border bg-fd-muted/40 p-6 sm:p-8">
          <h2 className="text-lg font-semibold">学习路径</h2>
          <ol className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
            {[
              ['01', '起步', '环境准备、整体架构、为什么 Claude Code 长这样'],
              ['02', '核心循环', 'agent loop、流式响应、工具调用协议、多模型接入'],
              ['03', '工具系统', 'schema 派生、文件工具、搜索工具、命令执行'],
              ['04', '工程化', '系统提示词、权限模型、上下文压缩、项目记忆'],
              ['05', '进阶', '子代理、MCP 接入、钩子、打包发布'],
              ['06', '实战', '端到端完成一个真实任务，并复盘设计取舍'],
            ].map(([index, title, description]) => (
              <li key={index} className="flex gap-3">
                <span className="font-mono text-xs text-fd-primary">{index}</span>
                <span>
                  <span className="font-medium">{title}</span>
                  <span className="mt-0.5 block text-fd-muted-foreground">
                    {description}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
    </div>
  );
}
