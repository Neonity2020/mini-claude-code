import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';
import { BUILTIN_TOOLS } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { FileReadTrackerImpl } from '../src/tools/fs-utils.js';

/** 造一个临时的沙箱目录，跑完就删 */
async function withSandbox<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-test-'));
  try {
    return await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function makeContext(cwd: string): ToolContext {
  return {
    cwd,
    signal: AbortSignal.timeout(10_000),
    confirm: async () => true,
    write: () => {},
    todos: [],
    fileReads: new FileReadTrackerImpl(),
  };
}

const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);

test('注册表能为每个工具生成合法 JSON Schema', () => {
  const tools = registry.toAnthropicTools();

  assert.equal(tools.length, BUILTIN_TOOLS.length);

  for (const tool of tools) {
    assert.ok(tool.name.length > 0);
    assert.ok(tool.description.length > 10, `${tool.name} 的描述太短，模型会用不好`);

    const schema = tool.input_schema as Record<string, unknown>;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties, `${tool.name} 缺少 properties`);
  }
});

test('Read 能读取文件并返回带行号的内容', async () => {
  await withSandbox(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'a.txt'), 'line1\nline2\nline3\n');

    const result = await registry.get('Read')!.execute(
      { file_path: 'a.txt' },
      makeContext(cwd),
    );

    assert.match(result.content, /1\tline1/);
    assert.match(result.content, /3\tline3/);
  });
});

test('Read 拒绝读取工作目录之外的文件', async () => {
  await withSandbox(async (cwd) => {
    const result = await registry.get('Read')!.execute(
      { file_path: '../../etc/passwd' },
      makeContext(cwd),
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /拒绝读取/);
  });
});

test('Edit 替换成功且会标记文件已读', async () => {
  await withSandbox(async (cwd) => {
    const file = path.join(cwd, 'b.ts');
    await fs.writeFile(file, 'const a = 1;\nconst b = 2;\n');

    const ctx = makeContext(cwd);
    const result = await registry.get('Edit')!.execute(
      { file_path: 'b.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' },
      ctx,
    );

    assert.ok(!result.isError, result.content);
    assert.match(await fs.readFile(file, 'utf8'), /const a = 42;/);
  });
});

test('Edit 在 old_string 不唯一时拒绝执行', async () => {
  await withSandbox(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'c.ts'), 'x\nx\n');

    const result = await registry.get('Edit')!.execute(
      { file_path: 'c.ts', old_string: 'x', new_string: 'y' },
      makeContext(cwd),
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /出现了 2 次/);
  });
});

test('Write 创建文件并建立父目录', async () => {
  await withSandbox(async (cwd) => {
    const result = await registry.get('Write')!.execute(
      { file_path: 'nested/dir/new.txt', content: 'hello' },
      makeContext(cwd),
    );

    assert.ok(!result.isError, result.content);
    assert.equal(await fs.readFile(path.join(cwd, 'nested/dir/new.txt'), 'utf8'), 'hello');
  });
});

test('Glob 能匹配到文件', async () => {
  await withSandbox(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'x.ts'), '');
    await fs.writeFile(path.join(cwd, 'y.js'), '');

    const result = await registry.get('Glob')!.execute(
      { pattern: '**/*.ts' },
      makeContext(cwd),
    );

    assert.match(result.content, /x\.ts/);
    assert.doesNotMatch(result.content, /y\.js/);
  });
});

test('Grep 能找到匹配行并给出行号', async () => {
  await withSandbox(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'g.ts'), 'line1\nconst target = 1;\nline3\n');

    const result = await registry.get('Grep')!.execute(
      { pattern: 'target' },
      makeContext(cwd),
    );

    assert.match(result.content, /g\.ts:2/);
  });
});

test('Bash 执行命令并返回输出', async () => {
  await withSandbox(async (cwd) => {
    const result = await registry.get('Bash')!.execute(
      { command: 'echo hello-mcc' },
      makeContext(cwd),
    );

    assert.ok(!result.isError, result.content);
    assert.match(result.content, /hello-mcc/);
  });
});

test('Bash 失败时标记 isError', async () => {
  await withSandbox(async (cwd) => {
    const result = await registry.get('Bash')!.execute(
      { command: 'exit 3' },
      makeContext(cwd),
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /exit code: 3/);
  });
});

test('TodoWrite 拒绝同时存在多个进行中的任务', async () => {
  await withSandbox(async (cwd) => {
    const result = await registry.get('TodoWrite')!.execute(
      {
        todos: [
          { content: 'a', status: 'in_progress' },
          { content: 'b', status: 'in_progress' },
        ],
      },
      makeContext(cwd),
    );

    assert.equal(result.isError, true);
  });
});


test('Bash 复合命令和只读命令都需要确认', async () => {
  const { PermissionManager } = await import('../src/permissions.js');
  const permissions = new PermissionManager();
  const bash = registry.get('Bash')!;
  for (const command of ['echo ok; touch changed', 'ls > changed', 'echo $(touch changed)', 'ls']) {
    assert.equal(permissions.check(bash, { command }).decision, 'ask', command);
  }
});

test('文件和搜索工具拒绝通过符号链接访问工作目录之外', async () => {
  await withSandbox(async (cwd) => {
    await withSandbox(async (outside) => {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      await fs.symlink(outside, path.join(cwd, 'link'));
      const ctx = makeContext(cwd);
      for (const [name, input] of [
        ['Read', { file_path: 'link/secret.txt' }],
        ['Write', { file_path: 'link/new.txt', content: 'bad' }],
        ['Edit', { file_path: 'link/secret.txt', old_string: 'secret', new_string: 'bad' }],
        ['Glob', { path: 'link', pattern: '**/*' }],
        ['Grep', { path: 'link', pattern: 'secret' }],
      ] as const) {
        assert.equal((await registry.get(name)!.execute(input, ctx)).isError, true, name);
      }
      assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
      await assert.rejects(fs.stat(path.join(outside, 'new.txt')));
    });
  });
});

test('上下文压缩保留完整的工具调用及结果', async () => {
  const { ContextManager } = await import('../src/context.js');
  const manager = new ContextManager({ keepRecentMessages: 1 });
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ] as import('@anthropic-ai/sdk/resources/messages/messages.js').MessageParam[];
  const compacted = await manager.compact(messages);
  assert.deepEqual(compacted.slice(-2), messages.slice(-2));
});

test('Agent 按顺序执行同一轮工具调用并返回全部结果', async () => {
  const { Agent } = await import('../src/agent.js');
  const { z } = await import('zod');
  const events: string[] = [];
  const tools = new ToolRegistry().register({
    name: 'Test', description: '测试串行执行的工具', schema: z.object({ id: z.string() }),
    permission: 'allow', primaryParam: 'id',
    async execute(input) {
      events.push(`start:${input.id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${input.id}`);
      return { content: input.id };
    },
  });
  let calls = 0;
  const client = { messages: { stream: (request: { messages: unknown[] }) => ({
    on() {},
    async finalMessage() {
      calls++;
      if (calls === 1) return { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'a', name: 'Test', input: { id: 'a' } },
        { type: 'tool_use', id: 'b', name: 'Test', input: { id: 'b' } },
      ] };
      assert.equal((request.messages.at(-1) as { content: unknown[] }).content.length, 2);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
  }) } };
  const agent = new Agent({ client: client as never, tools, systemPrompt: '', model: 'test', cwd: process.cwd() });
  await agent.run('test');
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('请求失败后 Agent 丢弃不完整的消息并可继续对话', async () => {
  const { Agent } = await import('../src/agent.js');
  let calls = 0;
  const client = { messages: { stream: () => ({
    on() {},
    async finalMessage() {
      calls++;
      if (calls === 1) throw new Error('network failure');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
  }) } };
  const agent = new Agent({ client: client as never, tools: new ToolRegistry(), systemPrompt: '', model: 'test', cwd: process.cwd() });
  await assert.rejects(agent.run('first'));
  assert.equal(agent.messages.length, 0);
  await agent.run('second');
  assert.equal(agent.messages.length, 2);
});

test('OpenAI 流式工具调用可执行并将结果回传', async () => {
  const { Agent } = await import('../src/agent.js');
  const { createOpenAIClient } = await import('../src/openai.js');
  const { z } = await import('zod');
  const requests: Array<Record<string, any>> = [];
  const events = (chunks: unknown[]) => chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
  const responses = [events([
    { choices: [{ delta: { content: '准备', reasoning_content: '思考片段' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Test', arguments: '{"value":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }, finish_reason: 'tool_calls' }] },
  ]), events([{ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }])];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.test/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body)));
    const data = responses.shift()!;
    const bytes = new TextEncoder().encode(data);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 23)); controller.enqueue(bytes.slice(23)); controller.close(); } }));
  };
  const client = createOpenAIClient({ apiKey: 'test', baseURL: 'https://example.test/v1/', fetch: fakeFetch });
  const tools = new ToolRegistry().register({ name: 'Test', description: '测试工具', schema: z.object({ value: z.string() }), permission: 'allow', primaryParam: 'value', async execute(input) { return { content: `result:${input.value}` }; } });
  let output = '';
  const agent = new Agent({ client, tools, model: 'test-model', systemPrompt: 'system', cwd: process.cwd(), onText: (s) => { output += s; } });
  await agent.run('hi');
  assert.equal(output, '准备完成');
  assert.equal(requests[0]!.tools[0].function.name, 'Test');
  assert.deepEqual(requests[1]!.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'result:hello' });
  assert.equal(requests[1]!.messages.at(-2).tool_calls[0].function.arguments, '{"value":"hello"}');
  assert.equal(requests[1]!.messages.at(-2).reasoning_content, '思考片段');
});

test('OpenAI 流中断和 HTTP 错误不会作为成功响应', async () => {
  const { createOpenAIClient } = await import('../src/openai.js');
  for (const response of [new Response('bad key', { status: 401 }), new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')]) {
    const client = createOpenAIClient({ apiKey: 'test', fetch: async () => response });
    const stream = client.messages.stream({ model: 'test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    await assert.rejects(stream.finalMessage());
  }
});
