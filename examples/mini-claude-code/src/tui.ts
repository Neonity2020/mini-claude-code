import { emitKeypressEvents } from 'node:readline';

export type Entry = { kind: 'user' | 'assistant' | 'tool' | 'system' | 'error'; text: string };
type ConfirmRequest = { title: string; detail: string; target: string };

/** A small terminal UI. Rendering is isolated from the agent and never interprets model output as ANSI. */
export class TerminalUI {
  private entries: Entry[] = [];
  private input = '';
  private history: string[] = [];
  private historyIndex = 0;
  private busy = false;
  private scroll = 0;
  private confirmation?: { request: ConfirmRequest; resolve: (allowed: boolean) => void };
  private closed = false;
  onSubmit: (text: string) => void = () => {};
  onCancel: () => void = () => {};
  onExit: () => void = () => {};

  constructor(private readonly model: string, private readonly cwd: string) {}

  start(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('交互界面需要终端（TTY）。');
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.handleKey);
    process.stdout.on('resize', this.render);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    this.add('system', '输入问题开始对话。/help 查看命令，Ctrl+C 取消当前请求。');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.confirmation?.resolve(false);
    this.confirmation = undefined;
    process.stdin.off('keypress', this.handleKey);
    process.stdout.off('resize', this.render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }

  add(kind: Entry['kind'], text: string): void {
    this.entries.push({ kind, text });
    this.scroll = 0;
    this.render();
  }

  appendAssistant(delta: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === 'assistant') last.text += delta;
    else this.entries.push({ kind: 'assistant', text: delta });
    this.render();
  }

  setBusy(busy: boolean): void { this.busy = busy; this.render(); }
  clear(): void { this.entries = []; this.scroll = 0; this.render(); }

  confirm(request: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => { this.confirmation = { request, resolve }; this.render(); });
  }

  private handleKey = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
    if (key.ctrl && key.name === 'c') {
      if (this.confirmation) { this.confirmation.resolve(false); this.confirmation = undefined; this.render(); }
      else if (this.busy) this.onCancel();
      else this.onExit();
      return;
    }
    if (this.confirmation) {
      if (str.toLowerCase() === 'y' || str.toLowerCase() === 'n' || key.name === 'return' || key.name === 'escape') {
        this.confirmation.resolve(str.toLowerCase() === 'y');
        this.confirmation = undefined;
        this.render();
      }
      return;
    }
    if (key.name === 'pageup') { this.scroll += 5; this.render(); return; }
    if (key.name === 'pagedown') { this.scroll = Math.max(0, this.scroll - 5); this.render(); return; }
    if (this.busy) return;
    if (key.ctrl && key.name === 'd' && !this.input) { this.onExit(); return; }
    if (key.name === 'return') {
      const value = this.input.trim();
      if (!value) return;
      this.history.push(value); this.historyIndex = this.history.length; this.input = '';
      this.onSubmit(value); this.render(); return;
    }
    if (key.name === 'backspace') this.input = Array.from(this.input).slice(0, -1).join('');
    else if (key.name === 'up') { this.historyIndex = Math.max(0, this.historyIndex - 1); this.input = this.history[this.historyIndex] ?? ''; }
    else if (key.name === 'down') { this.historyIndex = Math.min(this.history.length, this.historyIndex + 1); this.input = this.history[this.historyIndex] ?? ''; }
    else if (str && !key.ctrl && !/[\x00-\x1f\x7f]/.test(str)) this.input += str;
    this.render();
  };

  private render = (): void => {
    if (this.closed || !process.stdout.isTTY) return;
    const width = Math.max(20, process.stdout.columns || 80);
    const height = Math.max(8, process.stdout.rows || 24);
    const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    // Count full-width characters as two terminal cells.
    const wrap = (text: string): string[] => {
      const lines: string[] = []; let line = ''; let cells = 0;
      for (const char of clean(text)) {
        if (char === '\n') { lines.push(line); line = ''; cells = 0; continue; }
        const size = /[^\x00-\xff]/u.test(char) ? 2 : 1;
        if (cells + size > width - 2) { lines.push(line); line = ''; cells = 0; }
        line += char; cells += size;
      }
      lines.push(line); return lines;
    };
    const labels: Record<Entry['kind'], string> = { user: '你', assistant: '助手', tool: '工具', system: '提示', error: '错误' };
    const lines = this.entries.flatMap((entry) => [...wrap(`${labels[entry.kind]}  ${entry.text}`), '']);
    const footer = this.confirmation
      ? [`⚠ ${this.confirmation.request.title}`, this.confirmation.request.detail, this.confirmation.request.target, '允许执行？ [y/N]']
      : [this.busy ? '正在处理…  Ctrl+C 取消' : `› ${this.input || '输入消息，Enter 发送'}`, '↑↓ 历史  PgUp/PgDn 滚动  /help 帮助  Ctrl+C 退出'];
    const footerLines = footer.flatMap(wrap).slice(-(height - 4));
    const available = Math.max(1, height - 3 - footerLines.length);
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - available));
    const end = Math.max(0, lines.length - this.scroll);
    const body = lines.slice(Math.max(0, end - available), end);
    const header = wrap(`Mini Claude Code  ·  ${this.model}  ·  ${this.cwd}`)[0] ?? '';
    const screen = [header, '─'.repeat(Math.max(0, width - 1)), ...body];
    while (screen.length < height - footerLines.length - 1) screen.push('');
    screen.push(...footerLines);
    process.stdout.write('\x1b[H\x1b[2J' + screen.join('\r\n'));
  };
}
