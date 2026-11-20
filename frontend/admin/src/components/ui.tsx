/**
 * Admin UI primitives on the @omw/ui tokens: buttons with a tactile press, journal cards,
 * form fields wired for screen readers, segmented controls with a springy pill, switches,
 * badges, native <dialog> sheets and loading/empty states.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { SPRINGS } from '@omw/ui/motion';
import { Link } from '@tanstack/react-router';
import * as m from 'motion/react-m';
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ComponentType,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from 'react';
import { friendlyError } from '../lib/errors';
import {
  AlertIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  type IconProps,
  RefreshIcon,
} from './icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Buttons

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent shadow-soft hover:bg-accent-strong hover:shadow-lift',
  secondary: 'bg-surface text-ink ring-1 ring-line ring-inset hover:bg-blush',
  ghost: 'text-ink hover:bg-blush',
  soft: 'bg-blush text-accent-strong hover:bg-blush-strong',
  danger: 'bg-surface text-danger ring-1 ring-line ring-inset hover:bg-blush',
};

// Touch screens get 44 px targets (pointer: coarse); the compact look stays for mouse users.
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-9 gap-1.5 px-3.5 text-sm pointer-coarse:min-h-11',
  md: 'min-h-11 gap-2 px-5 text-[0.95rem]',
  lg: 'min-h-13 gap-2.5 px-6 text-base',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', extra?: string): string {
  return cx(
    'press inline-flex select-none items-center justify-center rounded-pill text-center leading-tight font-bold',
    'disabled:cursor-not-allowed disabled:opacity-55',
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export type Icon = ComponentType<IconProps>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Icon | undefined;
  /** Shows a spinner and sets aria-busy (the button stays focusable). */
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon: IconCmp,
  busy = false,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button type={type} aria-busy={busy || undefined} className={buttonClass(variant, size, className)} {...props}>
      {busy ? <Spinner className="size-4" /> : IconCmp ? <IconCmp className="size-[1.15em]" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: Icon;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function IconButton({
  label,
  icon: IconCmp,
  variant = 'ghost',
  size = 'md',
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'press inline-flex shrink-0 items-center justify-center rounded-pill disabled:opacity-50',
        size === 'md' ? 'size-11' : 'size-9 pointer-coarse:size-11',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      <IconCmp className={size === 'md' ? 'size-5' : 'size-[1.1rem]'} />
    </button>
  );
}

export function Spinner({ className = 'size-5', label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx('animate-spin-soft', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Layout

export function Card({
  children,
  className,
  tape = false,
  as: Tag = 'div',
  ...props
}: HTMLAttributes<HTMLElement> & { tape?: boolean; as?: 'div' | 'section' | 'article' | 'li' }) {
  return (
    <Tag
      className={cx('min-w-0 rounded-card bg-surface p-5 shadow-soft', tape && 'washi-tape mt-3', className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

export interface ScreenHeaderProps {
  /** Handwritten line above the title (e.g. today's date). */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string; params?: Record<string, string> } | undefined;
}

export function ScreenHeader({ eyebrow, title, subtitle, actions, back }: ScreenHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-2">
      <div className="min-w-0 flex-1">
        {back && (
          <Link
            to={back.to}
            {...(back.params ? { params: back.params } : {})}
            className="press -ms-2 mb-2 inline-flex min-h-10 items-center gap-1 rounded-pill pe-3 ps-1.5 text-sm font-bold text-muted hover:bg-blush hover:text-ink pointer-coarse:min-h-11"
          >
            <ChevronLeftIcon className="size-5" />
            {back.label}
          </Link>
        )}
        {eyebrow && <p className="font-hand text-[1.05rem] text-accent">{eyebrow}</p>}
        <h1 className="display-soft text-[2.1rem] leading-[1.1] font-semibold text-ink sm:text-[2.6rem]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-prose text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled card section of a form or settings page. */
export function Section({
  title,
  description,
  icon: IconCmp,
  children,
  className,
  actions,
  id,
  ref,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: Icon;
  children?: ReactNode;
  className?: string;
  actions?: ReactNode;
  id?: string;
  ref?: Ref<HTMLElement>;
}) {
  const headingId = useId();
  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      id={id}
      className={cx('min-w-0 rounded-card bg-surface p-5 shadow-soft sm:p-6', className)}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          {IconCmp && (
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-pill bg-blush text-accent">
              <IconCmp className="size-[1.15rem]" />
            </span>
          )}
          <div className="min-w-0">
            <h2 id={headingId} className="display-soft text-xl font-semibold">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Forms

export const inputClass = cx(
  'w-full rounded-tile border border-line bg-bg px-3.5 py-2.5 text-ink placeholder:text-muted/70',
  'transition-[border-color,box-shadow] duration-150 hover:border-blush-strong',
  'focus:border-ring focus:outline-none focus:ring-3 focus:ring-ring/25',
  'aria-[invalid=true]:border-danger disabled:opacity-60',
);

export interface FieldIds {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** Label + control + hint/error, with the ids wired for assistive tech. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
  labelAside,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (ids: FieldIds) => ReactNode;
  className?: string;
  labelAside?: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-bold text-ink">
          {label}
        </label>
        {labelAside}
      </div>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
      })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-1 text-xs font-semibold text-danger">
          <AlertIcon className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cx(inputClass, className)} {...props} />;
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cx(inputClass, 'leading-relaxed', className)} {...props} />;
}

export function SelectInput({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputClass, 'appearance-auto pe-3', className)} {...props}>
      {children}
    </select>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: Icon;
}

/** Single choice as a pill group: native radio buttons (arrow keys, form semantics) with a springy pill. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const group = useId();
  return (
    <fieldset className={cx('inline-flex max-w-full min-w-0 gap-1 rounded-pill bg-blush p-1', className)}>
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const selected = o.value === value;
        const IconCmp = o.icon;
        return (
          <label
            key={o.value}
            className={cx(
              'press relative inline-flex flex-auto cursor-pointer items-center justify-center gap-1.5 rounded-pill font-bold whitespace-nowrap',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              size === 'md'
                ? 'min-h-10 px-3 text-sm pointer-coarse:min-h-11'
                : 'min-h-8 px-2.5 text-[0.8rem] pointer-coarse:min-h-11',
              selected ? 'text-ink' : 'text-muted hover:text-ink',
            )}
          >
            <input
              type="radio"
              name={group}
              value={o.value}
              checked={selected}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {selected && (
              <m.span
                layoutId={`seg-${group}`}
                transition={SPRINGS.soft}
                className="absolute inset-0 rounded-pill bg-surface shadow-soft"
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {IconCmp && <IconCmp className="size-4" />}
              {o.label}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="font-bold">
          {label}
        </label>
        {description && (
          <p id={`${id}-d`} className="mt-0.5 text-sm text-muted">
            {description}
          </p>
        )}
      </div>
      {/* On touch screens the (invisible) input reaches past the track: a 44 px target. */}
      <span className="relative mt-0.5 inline-flex shrink-0 pointer-coarse:-my-1.5 pointer-coarse:-me-1.5 pointer-coarse:p-1.5">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          disabled={disabled}
          aria-describedby={description ? `${id}-d` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={cx(
            'inline-flex h-8 w-13 items-center rounded-pill p-1 transition-colors duration-200',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50',
            'peer-active:scale-95 motion-reduce:peer-active:scale-100',
            checked ? 'bg-accent' : 'bg-blush-strong',
          )}
        >
          <m.span
            layout
            transition={SPRINGS.snappy}
            className={cx('size-6 rounded-pill bg-surface shadow-soft', checked ? 'ms-auto' : 'me-auto')}
          />
        </span>
      </span>
    </div>
  );
}

/** Picture choice as native radio buttons (keyboard + screen readers for free). */
export function ImageChoice({
  name,
  label,
  checked,
  onChange,
  children,
  className,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cx(
        'press relative block cursor-pointer overflow-hidden rounded-tile ring-offset-2 ring-offset-surface',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        checked ? 'ring-3 ring-accent' : 'hover:ring-2 hover:ring-blush-strong',
        className,
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} aria-label={label} className="sr-only" />
      {children}
      {checked && (
        <span className="absolute end-1.5 top-1.5 grid size-6 place-items-center rounded-pill bg-accent text-on-accent shadow-soft">
          <CheckIcon className="size-4" />
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------------------------
// Status bits

export type BadgeTone = 'rose' | 'lilac' | 'success' | 'danger' | 'neutral' | 'ink';

const TONES: Record<BadgeTone, string> = {
  rose: 'bg-blush text-accent-strong',
  lilac: 'bg-lilac text-violet',
  success: 'bg-success/14 text-success-strong',
  danger: 'bg-danger/12 text-danger',
  neutral: 'bg-surface-2 text-muted',
  ink: 'bg-ink text-bg',
};

export function Badge({
  tone = 'rose',
  icon: IconCmp,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: Icon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-bold whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {IconCmp && <IconCmp className="size-3.5" />}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('skeleton rounded-tile', className)} />;
}

export function EmptyState({
  icon: IconCmp,
  title,
  children,
  action,
}: {
  icon?: Icon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-card border-2 border-dashed border-line px-6 py-10 text-center">
      {IconCmp && (
        <span className="mb-3 grid size-14 place-items-center rounded-pill bg-blush text-accent">
          <IconCmp className="size-7" />
        </span>
      )}
      <p className="display-soft text-xl font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** The technical text of an error, folded away ("Details"). */
export function ErrorDetails({ detail, className }: { detail: string | null; className?: string }) {
  if (!detail) return null;
  return (
    <details className={cx('group text-xs', className)}>
      <summary className="press inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-pill font-bold opacity-80 hover:opacity-100 pointer-coarse:min-h-11">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
        <Trans>Details</Trans>
      </summary>
      <p className="mt-1 font-mono break-words opacity-80" dir="ltr">
        {detail}
      </p>
    </details>
  );
}

/** Error card with a retry button for a failed query (warm text; the technical one in Details). */
export function QueryError({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  const { i18n } = useLingui();
  if (!error) return null;
  const friendly = friendlyError(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card bg-danger/10 p-4 text-danger sm:col-span-2 lg:col-span-3"
    >
      <AlertIcon className="mt-0.5 size-5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_14rem]">
          <p className="font-bold">
            <Trans>Could not load this.</Trans>
          </p>
          <p className="text-sm break-words">{i18n._(friendly.message)}</p>
          <ErrorDetails detail={friendly.detail} className="mt-1" />
        </div>
        {onRetry && (
          <Button variant="secondary" size="sm" icon={RefreshIcon} onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialog (native <dialog>: focus trap, Escape and inert background come from the platform)

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeLabel,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click only; <dialog> handles Escape natively (onCancel)
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        // Browsers close a modal on a repeated Escape even when `cancel` is prevented (close
        // watcher rules). Keep React in charge: report it, or reopen a sheet that needs an answer.
        if (!open) return;
        if (dismissible) onClose();
        else ref.current?.showModal();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      className={cx(
        'm-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-sheet border-0 bg-surface p-0 text-ink shadow-float',
        'sm:m-auto sm:max-w-lg sm:rounded-sheet',
        'transition-[translate,opacity] duration-300 ease-soft starting:translate-y-6 starting:opacity-0',
      )}
    >
      {open && (
        <div className="px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-7 sm:pt-6 sm:pb-6">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-pill bg-line sm:hidden" aria-hidden="true" />
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 id={titleId} className="display-soft text-2xl font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            {dismissible && <IconButton label={closeLabel} icon={CloseIcon} size="sm" onClick={onClose} />}
          </div>
          {children}
          {footer && (
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Locale tabs (owner text per language)

export function LocaleTabs<T extends string>({
  label,
  locales,
  value,
  onChange,
  filled,
  original,
  originalLabel,
}: {
  label: string;
  locales: ReadonlyArray<{ code: T; label: string }>;
  value: T;
  onChange: (code: T) => void;
  filled?: ReadonlySet<string>;
  original?: T | null | undefined;
  originalLabel?: string;
}) {
  const group = useId();
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {locales.map((l) => {
        const selected = l.code === value;
        const isFilled = filled?.has(l.code) ?? false;
        return (
          <button
            key={l.code}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(l.code)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
              e.preventDefault();
              const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
              const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1;
              const i = locales.findIndex((x) => x.code === value);
              const j =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? locales.length - 1
                    : (i + step + locales.length) % locales.length;
              const next = locales[j];
              if (!next) return;
              onChange(next.code);
              // Focus follows the selection (WAI-ARIA tabs pattern with automatic activation).
              const tabs = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
              tabs?.[j]?.focus();
            }}
            tabIndex={selected ? 0 : -1}
            className={cx(
              'press relative inline-flex min-h-9 items-center gap-1.5 rounded-pill px-3.5 text-sm font-bold pointer-coarse:min-h-11',
              selected ? 'text-on-accent' : 'bg-blush text-muted hover:text-ink',
            )}
          >
            {selected && (
              <m.span
                layoutId={`loc-${group}`}
                transition={SPRINGS.soft}
                className="absolute inset-0 rounded-pill bg-accent"
              />
            )}
            <span className="relative">{l.label}</span>
            {original === l.code && originalLabel ? (
              <span
                className={cx(
                  'relative rounded-pill px-1.5 py-px text-[0.65rem] font-extrabold tracking-wide uppercase',
                  selected ? 'bg-on-accent/20' : 'bg-surface',
                )}
              >
                {originalLabel}
              </span>
            ) : (
              isFilled && (
                <span
                  className={cx('relative size-1.5 rounded-pill', selected ? 'bg-on-accent' : 'bg-accent')}
                  aria-hidden="true"
                />
              )
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Sticky action bar at the bottom of long forms, above the phone tab bar (or the keyboard while
 * typing). Render it as a direct child of the page (or of the form it belongs to): sticky
 * positioning works within its parent, so a wrapper of its own height would pin it in place.
 */
export function StickyActions({
  children,
  note,
  className,
}: {
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div data-sticky-actions className={cx('sticky-actions sticky z-20 mt-6', className)}>
      <div className="flex flex-wrap items-center justify-end gap-2 rounded-pill bg-surface/90 p-2 shadow-float ring-1 ring-line backdrop-blur-md">
        {note && <div className="min-w-0 flex-1 px-3 text-sm text-muted">{note}</div>}
        {children}
      </div>
    </div>
  );
}
