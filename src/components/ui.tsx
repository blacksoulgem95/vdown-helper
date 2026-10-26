import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-neon text-void font-semibold hover:bg-white hover:shadow-[0_0_18px_rgba(0,245,255,0.45)] disabled:bg-neon/30 disabled:text-void/60 disabled:shadow-none',
  secondary:
    'border border-neon/40 text-neon hover:bg-neon/10 hover:border-neon disabled:border-white/10 disabled:text-muted/60 disabled:hover:bg-transparent',
  ghost: 'text-muted hover:text-fg hover:bg-white/5 disabled:text-muted/40 disabled:hover:bg-transparent',
  danger: 'border border-danger/50 text-danger hover:bg-danger/10 disabled:opacity-40',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={cx(
        'mono inline-flex items-center justify-center gap-1.5 rounded-md uppercase tracking-[0.08em] transition-all duration-150 disabled:cursor-not-allowed select-none',
        size === 'sm' ? 'min-h-7 px-2.5 text-[10px]' : 'min-h-8 px-3.5 text-[11px]',
        VARIANTS[variant],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-neon disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = 'neon' | 'magenta' | 'acid' | 'muted' | 'danger';
const TONES: Record<Tone, string> = {
  neon: 'border-neon/40 text-neon bg-neon/5',
  magenta: 'border-magenta/45 text-magenta bg-magenta/5',
  acid: 'border-acid/45 text-acid bg-acid/5',
  muted: 'border-white/12 text-muted bg-white/[0.02]',
  danger: 'border-danger/50 text-danger bg-danger/5',
};

export function Badge({
  tone = 'muted',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'mono inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-px text-[10px] uppercase tracking-wider',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'li';
}) {
  return <Tag className={cx('glass', className)}>{children}</Tag>;
}

export function ProgressBar({
  fraction,
  label,
  tone = 'neon',
  paused,
}: {
  /** 0..1, or undefined for "not measurable" (shows an indeterminate sweep, never a made-up percentage). */
  fraction: number | undefined;
  label: string;
  tone?: 'neon' | 'magenta' | 'acid' | 'danger';
  paused?: boolean;
}) {
  const color = { neon: 'bg-neon', magenta: 'bg-magenta', acid: 'bg-acid', danger: 'bg-danger' }[tone];
  const known = fraction !== undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      {...(known
        ? { 'aria-valuenow': Math.round(fraction * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }
        : {})}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/8"
    >
      {known ? (
        <div
          className={cx('h-full rounded-full transition-[width] duration-300', color, paused && 'opacity-50')}
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      ) : (
        <div className={cx('absolute inset-y-0 w-2/5 rounded-full animate-sweep', color)} />
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[13px] text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
      </div>
      <button
        id={id}
        role="switch"
        type="button"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40',
          checked ? 'border-neon bg-neon/20' : 'border-white/20 bg-white/5',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all',
            checked ? 'left-[18px] bg-neon shadow-[0_0_8px_#00f5ff]' : 'left-0.5 bg-muted',
          )}
        />
      </button>
    </div>
  );
}

const fieldBase =
  'mono w-full rounded-md border border-white/15 bg-void/70 px-2.5 py-1.5 text-[12px] text-fg transition-colors placeholder:text-muted/60 hover:border-neon/40 focus:border-neon disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  options,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}) {
  const id = useId();
  return (
    <Field label={label} {...(hint ? { hint } : {})} htmlFor={id}>
      <select id={id} {...rest} className={cx(fieldBase, 'appearance-none bg-[length:10px] pr-7', className)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} className="bg-surface">
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextField({
  label,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Field label={label} {...(hint ? { hint } : {})} htmlFor={id}>
      <input id={id} {...rest} className={cx(fieldBase, className)} />
    </Field>
  );
}

export function Notice({
  tone = 'muted',
  children,
  role,
}: {
  tone?: 'muted' | 'neon' | 'danger' | 'magenta' | 'acid';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  const tones = {
    muted: 'border-white/12 text-muted',
    neon: 'border-neon/35 text-neon bg-neon/[0.04]',
    danger: 'border-danger/45 text-danger bg-danger/[0.05]',
    magenta: 'border-magenta/40 text-magenta bg-magenta/[0.04]',
    acid: 'border-acid/40 text-acid bg-acid/[0.04]',
  };
  return (
    <div
      {...(role ? { role } : {})}
      className={cx('rounded-md border px-2.5 py-2 text-[12px] leading-snug', tones[tone])}
    >
      {children}
    </div>
  );
}
