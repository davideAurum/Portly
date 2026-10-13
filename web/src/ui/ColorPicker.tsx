/**
 * ColorPicker (§10.4): 12 swatches (a radio group), a native color input and a hex field. Only
 * `#rrggbb` / `#rrggbbaa` values are ever emitted (§4.5). ColorPickerPopover wraps it behind a
 * compact swatch button for lists.
 */
import { useEffect, useId, useState } from 'react';
import { Ban, Check, Pipette } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { HEX_COLOR_REGEX } from '@portly/shared';
import { SWATCHES, colorName, readableTextColor, toOpaqueHex } from '../lib/color.ts';
import { useField } from './Field.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './Popover.tsx';
import styles from './ColorPicker.module.css';

/** Accepts `#abc`, `abc`, `#aabbcc`, `aabbcc`, `#aabbccdd`; returns lower-case `#rrggbb[aa]` or null. */
export function normalizeHexInput(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value.startsWith('#')) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return HEX_COLOR_REGEX.test(value) ? value : null;
}

export interface ColorPickerProps {
  value: string | null;
  onChange(color: string): void;
  /** Offer a "no color" choice (calls onClear). */
  onClear?: () => void;
  swatches?: readonly string[];
  'aria-label'?: string;
  disabled?: boolean;
}

export function ColorPicker({ value, onChange, onClear, swatches = SWATCHES, disabled, ...aria }: ColorPickerProps) {
  const field = useField();
  const hexId = useId();
  const current = value && HEX_COLOR_REGEX.test(value) ? value.toLowerCase() : null;
  const [draft, setDraft] = useState(current ?? '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(current ?? '');
    setInvalid(false);
  }, [current]);

  const commitDraft = () => {
    if (draft.trim() === '') {
      setDraft(current ?? '');
      setInvalid(false);
      return;
    }
    const normalized = normalizeHexInput(draft);
    if (normalized === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (normalized !== current) onChange(normalized);
  };

  const radioValue = current && swatches.includes(current) ? current : current === null && onClear ? 'none' : '';
  const groupLabel = aria['aria-label'];

  return (
    <div className={styles.picker} data-disabled={disabled ? 'true' : undefined}>
      <RadioGroup.Root
        className={styles.swatches}
        value={radioValue}
        onValueChange={(next) => {
          if (next === 'none') onClear?.();
          else onChange(next);
        }}
        disabled={disabled}
        loop
        aria-label={groupLabel ?? (field ? undefined : 'Color')}
        aria-labelledby={groupLabel ? undefined : field?.labelId}
      >
        {onClear ? (
          <RadioGroup.Item value="none" className={styles.swatch} data-none="true" aria-label="No color" title="No color">
            <Ban aria-hidden="true" className={styles.noneIcon} />
          </RadioGroup.Item>
        ) : null}
        {swatches.map((swatch) => (
          <RadioGroup.Item
            key={swatch}
            value={swatch}
            className={styles.swatch}
            style={{ backgroundColor: swatch, color: readableTextColor(swatch) }}
            aria-label={colorName(swatch)}
            aria-description={colorName(swatch) === swatch ? undefined : swatch}
            title={colorName(swatch) === swatch ? swatch : `${colorName(swatch)} (${swatch})`}
          >
            <RadioGroup.Indicator className={styles.indicator}>
              <Check aria-hidden="true" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      <div className={styles.custom}>
        <label className={styles.native} title="Pick any color" style={current ? { backgroundColor: current } : undefined}>
          <Pipette aria-hidden="true" style={current ? { color: readableTextColor(current) } : undefined} />
          <input
            type="color"
            className="hb-visually-hidden"
            aria-label="Custom color"
            value={toOpaqueHex(current ?? '#3b82f6')}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value.toLowerCase())}
          />
        </label>
        <label htmlFor={hexId} className="hb-visually-hidden">
          Hex color
        </label>
        <input
          id={hexId}
          className={styles.hex}
          value={draft}
          placeholder="#rrggbb"
          spellCheck={false}
          autoComplete="off"
          maxLength={9}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setInvalid(false);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft();
            }
          }}
        />
      </div>
    </div>
  );
}

export interface ColorPickerPopoverProps extends ColorPickerProps {
  /** Accessible name of the trigger, e.g. "Account color". */
  label: string;
  size?: 'sm' | 'md';
}

/** A swatch button that opens a ColorPicker in a popover. */
export function ColorPickerPopover({ label, size = 'md', ...props }: ColorPickerPopoverProps) {
  const color = props.value && HEX_COLOR_REGEX.test(props.value) ? props.value : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-size={size}
          aria-label={`${label}: ${color ?? 'none'}`}
          disabled={props.disabled}
          style={color ? { backgroundColor: color } : undefined}
          data-empty={color ? undefined : 'true'}
        />
      </PopoverTrigger>
      <PopoverContent aria-label={label}>
        <ColorPicker {...props} aria-label={label} />
      </PopoverContent>
    </Popover>
  );
}
