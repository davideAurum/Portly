/**
 * Checkbox, Switch, SegmentedControl and Slider (§10.4). Checkbox/Switch/SegmentedControl are
 * Radix primitives (keyboard support, roles, states); Slider is a native range input.
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import { Check, Minus, type LucideIcon } from 'lucide-react';
import { Checkbox as RadixCheckbox, RadioGroup, Switch as RadixSwitch } from 'radix-ui';
import { useField, useFieldControlProps } from './Field.tsx';
import styles from './Toggles.module.css';

interface LabelledToggleProps {
  label?: ReactNode;
  /** Secondary text under the label. */
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

export interface CheckboxProps extends LabelledToggleProps {
  checked: boolean | 'indeterminate';
  onCheckedChange(checked: boolean): void;
}

export function Checkbox({ checked, onCheckedChange, label, description, disabled, id, className, ...aria }: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const descId = description ? `${controlId}-desc` : undefined;
  return (
    <div className={[styles.row, className].filter(Boolean).join(' ')} data-disabled={disabled ? 'true' : undefined}>
      <RadixCheckbox.Root
        id={controlId}
        className={styles.checkbox}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        aria-label={aria['aria-label']}
        aria-describedby={descId}
      >
        <RadixCheckbox.Indicator className={styles.checkIndicator}>
          {checked === 'indeterminate' ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label || description ? (
        <div className={styles.text}>
          {label ? (
            <label htmlFor={controlId} className={styles.label}>
              {label}
            </label>
          ) : null}
          {description ? (
            <p id={descId} className={styles.description}>
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface SwitchProps extends LabelledToggleProps {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  size?: 'sm' | 'md';
}

/** A labelled on/off switch (label left, switch right). Inside a Field, it uses the Field's label. */
export function Switch({ checked, onCheckedChange, label, description, disabled, id, className, size = 'md', ...aria }: SwitchProps) {
  const generated = useId();
  const field = useField();
  const fieldProps = useFieldControlProps({ id });
  const controlId = fieldProps.id ?? id ?? generated;
  const descId = description ? `${controlId}-desc` : undefined;
  const control = (
    <RadixSwitch.Root
      id={controlId}
      className={styles.switch}
      data-size={size}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={aria['aria-label']}
      aria-describedby={[descId, fieldProps['aria-describedby']].filter(Boolean).join(' ') || undefined}
    >
      <RadixSwitch.Thumb className={styles.thumb} />
    </RadixSwitch.Root>
  );
  if (field || (!label && !description)) return control;
  return (
    <div className={[styles.switchRow, className].filter(Boolean).join(' ')} data-disabled={disabled ? 'true' : undefined}>
      <div className={styles.text}>
        {label ? (
          <label htmlFor={controlId} className={styles.label}>
            {label}
          </label>
        ) : null}
        {description ? (
          <p id={descId} className={styles.description}>
            {description}
          </p>
        ) : null}
      </div>
      {control}
    </div>
  );
}

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: LucideIcon;
  /** Hide the text label (icon only); the label stays as the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  value: V;
  onValueChange(value: V): void;
  options: readonly SegmentedOption<V>[];
  /** Required unless inside a Field (which labels the group). */
  'aria-label'?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Stretch segments to fill the width. */
  block?: boolean;
}

/** A single-choice segmented control (radio group semantics, arrow-key navigation). */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  size = 'md',
  disabled,
  block = false,
  ...aria
}: SegmentedControlProps<V>) {
  const field = useField();
  return (
    <RadioGroup.Root
      className={styles.segmented}
      data-size={size}
      data-block={block ? 'true' : undefined}
      value={value}
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onValueChange(option.value);
      }}
      orientation="horizontal"
      loop
      disabled={disabled}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-label'] ? undefined : field?.labelId}
      aria-describedby={field?.describedBy}
    >
      {options.map(({ value: optionValue, label, icon: Icon, iconOnly, disabled: optionDisabled }) => (
        <RadioGroup.Item
          key={optionValue}
          value={optionValue}
          className={styles.segment}
          disabled={optionDisabled}
          aria-label={iconOnly ? label : undefined}
          title={iconOnly ? label : undefined}
        >
          {Icon ? <Icon aria-hidden="true" className={styles.segmentIcon} /> : null}
          {iconOnly ? null : <span>{label}</span>}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export interface SliderProps {
  value: number;
  onChange(value: number): void;
  min: number;
  max: number;
  step?: number;
  /** Formats the value readout (and aria-valuetext). */
  format?: (value: number) => string;
  'aria-label'?: string;
  disabled?: boolean;
  id?: string;
}

/** A range input with a live value readout. */
export function Slider({ value, onChange, min, max, step = 1, format = String, disabled, id, ...aria }: SliderProps) {
  const fieldProps = useFieldControlProps({ id });
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const text = format(value);
  return (
    <div className={styles.slider}>
      <input
        type="range"
        id={fieldProps.id}
        aria-describedby={fieldProps['aria-describedby']}
        aria-label={aria['aria-label']}
        aria-valuetext={text}
        className={styles.range}
        style={{ '--hb-range-fill': `${percent}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output className={styles.readout} htmlFor={fieldProps.id} aria-hidden="true">
        {text}
      </output>
    </div>
  );
}
