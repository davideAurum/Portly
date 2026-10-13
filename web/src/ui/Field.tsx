/**
 * Field (§10.4): label + control + help + error, wired for assistive tech. Controls inside a
 * Field (Input, TextArea, Select, ColorPicker, SegmentedControl, …) pick up the generated id,
 * `aria-describedby` and `aria-invalid` from context, so forms never hand-wire ids.
 */
import { createContext, useContext, useId, type ReactNode } from 'react';
import styles from './Field.module.css';

export interface FieldContextValue {
  /** id for the control (the <label> points at it). */
  id: string;
  /** id of the label element (for controls that are not labelable, e.g. radio groups). */
  labelId: string;
  /** ids of help/error text. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

/** Props a native control needs to be associated with its Field (explicit props win). */
export function useFieldControlProps(props: {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined;
  required?: boolean | undefined;
}) {
  const field = useField();
  return {
    id: props.id ?? field?.id,
    'aria-describedby': props['aria-describedby'] ?? field?.describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid ? true : undefined),
    required: props.required ?? (field?.required || undefined),
  };
}

export interface FieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Help text under the control. */
  help?: ReactNode;
  /** Validation error (also marks the control aria-invalid). */
  error?: ReactNode;
  required?: boolean;
  /** Explicit control id (otherwise generated). */
  id?: string;
  /** Visually hide the label (it stays available to screen readers). */
  hideLabel?: boolean;
  /** Label and control on one row (e.g. switches). */
  inline?: boolean;
  className?: string;
}

export function Field({ label, children, help, error, required = false, id, hideLabel = false, inline = false, className }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const labelId = `${generated}-label`;
  const helpId = help ? `${generated}-help` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

  return (
    <FieldContext.Provider value={{ id: controlId, labelId, describedBy, invalid: Boolean(error), required }}>
      <div className={[styles.field, className].filter(Boolean).join(' ')} data-inline={inline ? 'true' : undefined}>
        <label id={labelId} htmlFor={controlId} className={hideLabel ? 'hb-visually-hidden' : styles.label}>
          {label}
          {required ? (
            <span className={styles.required} aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </label>
        <div className={styles.control}>{children}</div>
        {error ? (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {help ? (
          <p id={helpId} className={styles.help}>
            {help}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** A titled group of fields (fieldset + legend). */
export function FieldGroup({ legend, description, children }: { legend: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{legend}</legend>
      {description ? <p className={styles.groupDescription}>{description}</p> : null}
      <div className={styles.groupBody}>{children}</div>
    </fieldset>
  );
}
