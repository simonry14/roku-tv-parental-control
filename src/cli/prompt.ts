import readline from 'node:readline';

/**
 * Questions in the terminal for the setup wizard. Works the same when typed (a TTY, with hidden
 * PIN entry) and when answers are piped in (tests, scripted installs): lines are queued as they
 * arrive, so none are lost between questions. With `assumeDefaults`, every question takes its
 * default without reading anything.
 */
export class Prompter {
  readonly interactive: boolean;
  private readonly rl: readline.Interface;
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;
  private mutedPrompt: string | null = null;

  constructor(
    private readonly opts: {
      assumeDefaults?: boolean;
      input?: NodeJS.ReadableStream & { isTTY?: boolean };
      output?: NodeJS.WritableStream;
    } = {},
  ) {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    this.interactive = Boolean(input.isTTY);
    this.rl = readline.createInterface({ input, output, terminal: this.interactive });
    this.rl.on('line', (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on('close', () => {
      this.ended = true;
      this.waiter?.(null);
      this.waiter = null;
    });
    this.rl.on('SIGINT', () => {
      output.write('\n\nSetup stopped. You can run it again any time.\n');
      process.exit(130);
    });
    // Hidden input: while muted, only the question itself is drawn, never the typed characters.
    const rl = this.rl as unknown as { _writeToOutput(s: string): void };
    const write = rl._writeToOutput.bind(this.rl);
    rl._writeToOutput = (s: string) => {
      if (this.mutedPrompt === null) return write(s);
      if (s.startsWith(this.mutedPrompt)) write(this.mutedPrompt);
    };
  }

  get output(): NodeJS.WritableStream {
    return this.opts.output ?? process.stdout;
  }

  private nextLine(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  private async read(question: string, hidden = false): Promise<string | null> {
    if (this.opts.assumeDefaults) {
      this.output.write(`${question}\n`);
      return null;
    }
    this.rl.setPrompt(question);
    if (hidden && this.interactive) this.mutedPrompt = question;
    this.rl.prompt();
    const line = await this.nextLine();
    if (this.mutedPrompt !== null) {
      this.mutedPrompt = null;
      this.output.write('\n');
    } else if (!this.interactive) {
      // Piped answers aren't echoed by the terminal; show them so the transcript reads well.
      this.output.write(`${hidden ? '' : (line ?? '')}\n`);
    }
    return line;
  }

  /** A free-text answer; empty (or no more input) gives the default. */
  async ask(question: string, def = ''): Promise<string> {
    const line = await this.read(`${question}${def ? ` [${def}]` : ''}: `);
    const answer = (line ?? '').trim();
    return answer === '' ? def : answer;
  }

  /** Yes/no with a default. */
  async confirm(question: string, def = true): Promise<boolean> {
    for (;;) {
      const line = await this.read(`${question} ${def ? '(Y/n)' : '(y/N)'}: `);
      const a = (line ?? '').trim().toLowerCase();
      if (a === '') return def;
      if (['y', 'yes'].includes(a)) return true;
      if (['n', 'no'].includes(a)) return false;
      this.output.write('  Please type y or n.\n');
    }
  }

  /** Typed without showing it (a PIN or password). Null when there's no more input. */
  async secret(question: string): Promise<string | null> {
    const line = await this.read(question, true);
    return line === null ? null : line.trim();
  }

  /** Wait for Enter. Returns what was typed (some steps accept "skip"). */
  async pause(question = 'Press Enter to continue'): Promise<string> {
    const line = await this.read(`${question}… `);
    return (line ?? '').trim().toLowerCase();
  }

  /** True once no more answers can come (piped answers used up, or taking defaults). */
  get exhausted(): boolean {
    return Boolean(this.opts.assumeDefaults) || (this.ended && this.queue.length === 0);
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * "8:30 pm", "8:30PM", "20:30", "8pm", "830pm", "7" → "HH:MM" (24-hour); null if not a time.
 */
export function parseClockInput(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.[0];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'a' && h === 12) h = 0;
    if (ampm === 'p' && h !== 12) h += 12;
  } else if (h > 23) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "20:30" → "8:30 PM". */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Hours of TV: "2", "1.5", "1:30", "90m", "90 min" → minutes; "0" or "none" → null (no limit). */
export function parseHoursInput(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (['0', 'none', 'no', 'unlimited', 'no limit'].includes(t)) return null;
  let m = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60) || null;
  m = /^(\d+):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]) || null;
  m = /^(\d+)\s*(m|min|mins|minutes)$/.exec(t);
  if (m) return Number(m[1]) || null;
  return undefined; // not understood
}
