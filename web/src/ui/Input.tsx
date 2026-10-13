/**
 * Text inputs (§10.4): Input, PasswordInput (show/hide), TextArea and Select (a styled native
 * <select> — the most robust, accessible option for short lists). All accept every native prop
 * (including `ref`) and associate with an enclosing Field automatically.
 */
import { useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useFieldControlProps } from './Field.tsx';
import styles from './Input.module.css';

type Size = 'sm' | 'md';

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'> {
  size?: Size;
  /** Decorative leading content (e.g. an icon). */
  leading?: ReactNode;
  /** Trailing content (e.g. a unit or a button). */
  trailing?: ReactNode;
}

export function Input({ size = 'md', leading, trailing, className, ...props }: InputProps) {
  const fieldProps = useFieldControlProps(props);
  const input = <input {...props} {...fieldProps} className={[styles.input, className].filter(Boolean).join(' ')} data-size={size} />;
  if (!leading && !trailing) return input;
  return (
    <div className={styles.affix} data-size={size}>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      {input}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </div>
  );
}

export type PasswordInputProps = Omit<InputProps, 'type' | 'trailing'>;

/** Password field with a show/hide toggle; never autofilled from saved logins of this site. */
export function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      autoComplete="new-password"
      spellCheck={false}
      autoCapitalize="off"
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          className={styles.reveal}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      }
    />
  );
}

export interface TextAreaProps extends ComponentProps<'textarea'> {
  /** Grow with the content (CSS field-sizing where supported). */
  autoGrow?: boolean;
}

export function TextArea({ className, autoGrow = false, ...props }: TextAreaProps) {
  const fieldProps = useFieldControlProps(props);
  return (
    <textarea
      rows={3}
      {...props}
      {...fieldProps}
      className={[styles.input, styles.textarea, className].filter(Boolean).join(' ')}
      data-autogrow={autoGrow ? 'true' : undefined}
    />
  );
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<'select'>, 'size'> {
  size?: Size;
  options?: readonly SelectOption[];
}

export function Select({ size = 'md', options, children, className, ...props }: SelectProps) {
  const fieldProps = useFieldControlProps(props);
  return (
    <div className={styles.selectWrap} data-size={size}>
      <select {...props} {...fieldProps} className={[styles.input, styles.select, className].filter(Boolean).join(' ')} data-size={size}>
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown aria-hidden="true" className={styles.chevron} />
    </div>
  );
}
