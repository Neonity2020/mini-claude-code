/** 终端颜色与符号 */
export const theme = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  gray: '[90m',
} as const;

export const symbols = {
  user: '›',
  assistant: '●',
  tool: '⏺',
  success: '✓',
  denied: '✗',
  pending: '⏳',
} as const;

export function paint(color: keyof typeof theme, text: string): string {
  return `${theme[color]}${text}${theme.reset}`;
}

/** 终端是否支持彩色 */
export function supportsColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

export function paintIf(color: keyof typeof theme, text: string): string {
  return supportsColor() ? paint(color, text) : text;
}
