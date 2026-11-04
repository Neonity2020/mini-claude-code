import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { CodeBlock } from 'fumadocs-ui/components/codeblock';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs, TabsContent, TabsList, TabsTrigger } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // 步骤流：把一章拆成有序的操作
    Steps,
    Step,
    // 选项卡：同一主题下的多种实现
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Tab,
    // 文件树：展示目录结构
    Files,
    Folder,
    File,
    // 折叠块：放「延伸阅读」「原理展开」
    Accordions,
    Accordion,
    // 参数表：讲清楚工具的入参契约
    TypeTable,
    // 代码块（带标题栏）
    CodeBlock,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
