import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export const c = (style: Style, s: string): string => (useColor ? styleText(style, s) : s);
export const bold = (s: string): string => c('bold', s);
export const dim = (s: string): string => c('dim', s);

/** Left-aligned label/value table. */
export function kv(rows: Array<[string, string]>, indent = 2): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${' '.repeat(indent)}${dim(k.padEnd(width))}  ${v}`).join('\n');
}

/** Simple column table. */
export function table(headers: string[], rows: string[][], indent = 2): string {
  // eslint-disable-next-line no-control-regex
  const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) => Math.max(strip(h).length, ...rows.map((r) => strip(r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    ' '.repeat(indent) +
    cells.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - strip(cell).length))).join('  ');
  return [line(headers.map((h) => dim(h))), ...rows.map(line)].join('\n');
}

/** Text bar for usage: ████░░░░ */
export function bar(fraction: number, width = 20): string {
  const f = Math.max(0, Math.min(1, fraction));
  const full = Math.round(f * width);
  return '█'.repeat(full) + dim('░'.repeat(width - full));
}
