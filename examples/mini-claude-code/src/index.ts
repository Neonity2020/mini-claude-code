#!/usr/bin/env node
import { Agent } from './agent.js';
import { ContextManager } from './context.js';
import { getModel, createClient } from './llm.js';
import { PermissionManager } from './permissions.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { BUILTIN_TOOLS, ToolRegistry } from './tools/index.js';
import { TerminalUI } from './tui.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  // .env is optional; existing environment variables retain precedence.
  try { process.loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const model = getModel();
  const client = createClient();
  const tools = new ToolRegistry().registerAll(BUILTIN_TOOLS);
  const permissions = new PermissionManager();
  const contextManager = new ContextManager({ client, model });
  const ui = new TerminalUI(model, cwd);
  const makeAgent = () => new Agent({
    client, tools, permissions, contextManager, systemPrompt: SYSTEM_PROMPT, model, cwd,
    onText: (delta) => ui.appendAssistant(delta),
    onToolStart: (name, input) => {
      if (name === '__log__') { ui.add('system', String(input)); return; }
      const data = input as Record<string, unknown>;
      const target = typeof data.command === 'string' ? data.command : typeof data.file_path === 'string' ? data.file_path : '';
      ui.add('tool', `${name}${target ? ` · ${target}` : ''}`);
    },
    onToolEnd: (name, result) => ui.add(result.isError ? 'error' : 'tool', `${name} ${result.isError ? '失败' : '完成'}${result.isError ? `：${result.content}` : ''}`),
    onConfirm: (request) => ui.confirm(request),
  });
  let agent = makeAgent();
  let cancelled = false;
  let compacting = false;
  ui.onExit = () => ui.close();
  ui.onCancel = () => {
    if (compacting) { ui.add('system', '上下文压缩进行中，请稍候。'); return; }
    cancelled = true; agent.abort(); ui.add('system', '正在取消…');
  };
  ui.onSubmit = (input) => {
    if (input.startsWith('/')) {
      const command = input.split(/\s+/)[0];
      if (command === '/exit' || command === '/quit') { ui.close(); return; }
      if (command === '/help') { ui.add('system', '/help 帮助 · /clear 清空会话 · /compact 压缩上下文 · /exit 退出\nEnter 发送 · ↑↓ 输入历史 · PgUp/PgDn 滚动 · Ctrl+C 取消或退出'); return; }
      if (command === '/clear') { agent = makeAgent(); ui.clear(); ui.add('system', '会话已清空。'); return; }
      if (command === '/compact') {
        compacting = true;
        ui.setBusy(true);
        void agent.compact().then((changed) => ui.add('system', changed ? '上下文已压缩。' : '当前会话无需压缩。'))
          .catch((error: Error) => ui.add('error', error.message)).finally(() => { compacting = false; ui.setBusy(false); });
        return;
      }
      ui.add('error', `未知命令：${command}`); return;
    }
    ui.add('user', input);
    ui.setBusy(true);
    cancelled = false;
    void agent.run(input).catch((error: Error) => ui.add(cancelled ? 'system' : 'error', cancelled ? '请求已取消。已完成的工具操作不会撤销。' : error.message))
      .finally(() => ui.setBusy(false));
  };
  ui.start();
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
