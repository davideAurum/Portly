/**
 * Button (primary | secondary | ghost | danger; sm | md; loading) and IconButton (§10.4).
 * IconButton requires an aria-label, which also becomes its tooltip.
 */
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Spinner } from './Spinner.tsx';
import { Tooltip } from './Tooltip.tsx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Leading icon. */
  icon?: LucideIcon;
  /** Stretch to the container width. */
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  block = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-block={block ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <Spinner size={size === 'sm' ? 14 : 16} />
      ) : Icon ? (
        <Icon aria-hidden="true" className={styles.icon} />
      ) : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  'aria-label': string;
  icon: LucideIcon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Tooltip text (defaults to the aria-label); pass `false` to disable. */
  tooltip?: ReactNode | false;
  /** For toggle buttons: rendered as aria-pressed. */
  pressed?: boolean;
}

export function IconButton({
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  loading = false,
  tooltip,
  pressed,
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      {...rest}
      type={type}
      className={[styles.button, styles.iconOnly, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={pressed}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : <Icon aria-hidden="true" className={styles.icon} />}
    </button>
  );
  if (tooltip === false) return button;
  return <Tooltip content={tooltip ?? rest['aria-label']}>{button}</Tooltip>;
}
