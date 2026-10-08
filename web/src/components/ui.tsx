import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

// ─── Icons (24px grid, 1.8 stroke, rounded — matches Rubik's softened corners) ─

const paths = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-6A1.5 1.5 0 0 1 5.5 11Z',
  unlock:
    'M7 11V8a5 5 0 0 1 9.6-1.9M5.5 11h13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-6A1.5 1.5 0 0 1 5.5 11Z',
  plus: 'M12 5v14M5 12h14',
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5.5v13l10.5-6.5L8 5.5Z',
  home: 'M4 11 12 4l8 7M6.5 9.5V20h11V9.5',
  tv: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-10A1.5 1.5 0 0 1 4.5 5ZM9 21h6',
  now: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2',
  rules: 'M5 6h14M5 12h14M5 18h9M17 16l2 2 3-3',
  history: 'M5 20V11M10 20V5M15 20v-7M20 20v-4',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 13.5l1.3 1-1.5 2.6-1.6-.5a7 7 0 0 1-1.7 1l-.3 1.6h-3l-.3-1.6a7 7 0 0 1-1.7-1l-1.6.5-1.5-2.6 1.3-1a7 7 0 0 1 0-2l-1.3-1 1.5-2.6 1.6.5a7 7 0 0 1 1.7-1l.3-1.6h3l.3 1.6a7 7 0 0 1 1.7 1l1.6-.5 1.5 2.6-1.3 1a7 7 0 0 1 0 2Z',
  warning: 'M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.5v.01',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Zm4 4h4',
  back: 'M15 5l-7 7 7 7',
  chevron: 'm9 6 6 6-6 6',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z',
  signal: 'M4 18h.01M8 18v-3M12 18v-6M16 18V9M20 18V6',
  message:
    'M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}

// ─── Buttons ────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'quiet' | 'danger' | 'ghost';

export function Button({
  variant = 'quiet',
  icon,
  children,
  busy,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-accent-ink hover:brightness-110',
    quiet: 'bg-raised text-text hover:bg-accent-soft',
    danger: 'bg-critical text-white hover:brightness-110',
    ghost: 'bg-transparent text-accent hover:bg-accent-soft',
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-medium transition-[filter,background-color] disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {icon && <Icon name={icon} size={18} />}
      {busy ? 'Working…' : children}
    </button>
  );
}

// ─── Form controls ──────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-full bg-raised p-1"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`min-h-10 rounded-full px-3 text-sm font-medium transition-colors ${
            o.value === value ? 'bg-surface text-text shadow-[0_1px_0_var(--line)]' : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-12 cursor-pointer items-center justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {description && <span className="block text-sm text-muted">{description}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="h-7 w-12 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />
        <span className="absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** Minutes stepper: − [ 1 h 30 min ] + ; null = "no limit" when allowNone. */
export function MinutesStepper({
  value,
  onChange,
  step = 15,
  min = 0,
  max = 1440,
  allowNone = false,
  noneLabel = 'No limit',
  label,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  allowNone?: boolean;
  noneLabel?: string;
  label: string;
}) {
  const show = value === null ? noneLabel : value === 0 ? '0 min' : formatMinutes(value);
  const dec = (): void => {
    if (value === null) return;
    const next = value - step;
    onChange(next < min ? (allowNone ? null : min) : next);
  };
  const inc = (): void => onChange(value === null ? Math.max(min, step) : Math.min(max, value + step));
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <button
        type="button"
        onClick={dec}
        disabled={value === null}
        aria-label={`Less ${label}`}
        className="grid size-10 place-items-center rounded-full bg-raised text-lg disabled:opacity-40"
      >
        −
      </button>
      <output aria-live="polite" className="tabular min-w-24 text-center text-[15px] font-medium">
        {show}
      </output>
      <button
        type="button"
        onClick={inc}
        aria-label={`More ${label}`}
        className="grid size-10 place-items-center rounded-full bg-raised text-lg"
      >
        +
      </button>
    </div>
  );
}

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
  inputMode,
  autoComplete = 'off',
  multiline = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'url';
  autoComplete?: string;
  /** A few lines of prose (spell-checked), with a character count when maxLength is set. */
  multiline?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const field =
    'w-full rounded-xl border border-line bg-surface px-4 text-[15px] placeholder:text-faint focus:border-accent focus:outline-none';
  return (
    <div className="py-2">
      <label htmlFor={id} className="mb-1 block text-sm text-muted">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          rows={3}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${field} block resize-none py-3 leading-snug`}
        />
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          inputMode={inputMode}
          autoComplete={autoComplete}
          spellCheck={false}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${field} min-h-12`}
        />
      )}
      {(hint || (multiline && maxLength)) && (
        <div className="mt-1 flex justify-between gap-3 text-sm text-muted">
          <p>{hint}</p>
          {multiline && maxLength && (
            <span className="tabular shrink-0 text-faint">
              {value.length}/{maxLength}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="border-t border-line py-6 first:border-t-0 first:pt-2">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {description && <p className="-mt-2 mb-3 max-w-prose text-sm text-muted">{description}</p>}
      {children}
    </section>
  );
}

export function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'critical' | 'info' | 'warning';
  icon?: IconName;
  children: ReactNode;
}) {
  const styles = {
    critical: 'bg-critical-soft text-text border-critical',
    warning: 'bg-raised text-text border-[var(--warning-mark)]',
    info: 'bg-accent-soft text-text border-accent',
  } as const;
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={`flex gap-3 rounded-2xl border-l-4 px-4 py-3 text-[15px] ${styles[tone]}`}
    >
      {icon && (
        <Icon
          name={icon}
          className={tone === 'critical' ? 'mt-0.5 shrink-0 text-critical' : 'mt-0.5 shrink-0 text-accent'}
        />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ─── Bottom sheet ───────────────────────────────────────────────────────────

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 backdrop:bg-black/50 sm:m-auto sm:max-w-md"
    >
      <div className="rounded-t-3xl bg-surface px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-text sm:rounded-3xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

// ─── Toasts ─────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-full px-4 py-2.5 text-[15px] shadow-lg ${
              t.tone === 'error' ? 'bg-critical text-white' : 'bg-text text-bg'
            }`}
          >
            <Icon name={t.tone === 'error' ? 'warning' : 'check'} size={18} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
