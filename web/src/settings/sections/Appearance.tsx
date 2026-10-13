/**
 * Appearance (§7a Theme, §4.5): mode, accent, background (color / gradient builder / uploaded
 * image with blur + dim), font, density, corner radius and widget opacity. Every change applies to
 * the whole app immediately (optimistic cache → applyTheme) and is saved with a debounced merge
 * patch.
 */
import { useRef, useState, type CSSProperties } from 'react';
import { Image as ImageIcon, Monitor, Moon, Paintbrush, Plus, RotateCcw, Sun, SwatchBook, Trash } from 'lucide-react';
import {
  ThemeSchema,
  defaultThemeBackground,
  type GradientStop,
  type Theme,
  type ThemeBackground,
  type ThemeInput,
  type SettingsPatch,
} from '@portly/shared';
import { useSettings, useSettingsAutosave } from '../../api/settings.ts';
import { backdropValue } from '../../theme/applyTheme.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { ColorPicker, ColorPickerPopover } from '../../ui/ColorPicker.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Field } from '../../ui/Field.tsx';
import { ImageUpload } from '../../ui/ImageUpload.tsx';
import { FieldGrid, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import { SegmentedControl, Slider } from '../../ui/Toggles.tsx';
import styles from '../../styles/settings.module.css';

const MAX_STOPS = 5;
const MIN_STOPS = 2;

/** Quick gradient starting points. */
export const GRADIENT_PRESETS: readonly { name: string; angle: number; stops: GradientStop[] }[] = [
  { name: 'Harbor', angle: 160, stops: [{ color: '#0b4f63', at: 0 }, { color: '#072f3b', at: 100 }] },
  { name: 'Dusk', angle: 160, stops: [{ color: '#1e3a8a', at: 0 }, { color: '#6d28d9', at: 100 }] },
  { name: 'Sea', angle: 135, stops: [{ color: '#0f766e', at: 0 }, { color: '#0e7490', at: 50 }, { color: '#1d4ed8', at: 100 }] },
  { name: 'Ember', angle: 145, stops: [{ color: '#7c2d12', at: 0 }, { color: '#be123c', at: 100 }] },
  { name: 'Mist', angle: 180, stops: [{ color: '#e2e8f0', at: 0 }, { color: '#cbd5e1', at: 100 }] },
  { name: 'Forest', angle: 150, stops: [{ color: '#14532d', at: 0 }, { color: '#365314', at: 100 }] },
  { name: 'Night', angle: 180, stops: [{ color: '#0f172a', at: 0 }, { color: '#1e293b', at: 100 }] },
];

/**
 * A merge patch that replaces `current` with `next` entirely: keys missing from `next` are sent
 * as null (merge patch deletes them), so switching background types never leaves stale fields.
 */
export function replacementPatch<T extends object>(current: object, next: T): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...(next as Record<string, unknown>) };
  for (const key of Object.keys(current)) if (!(key in next)) patch[key] = null;
  return patch;
}

export default function AppearanceSettings() {
  const settings = useSettings();
  if (settings.data === undefined) {
    return settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <SkeletonLines lines={6} />;
  }
  return <AppearanceForm theme={settings.data.appearance} />;
}

function AppearanceForm({ theme }: { theme: Theme }) {
  const autosave = useSettingsAutosave();
  // The image tab can be open before anything is uploaded.
  const [imageTab, setImageTab] = useState(false);
  const save = (patch: Partial<Record<keyof ThemeInput, unknown>> | null) => autosave.save({ appearance: patch } as SettingsPatch);

  const setBackground = (next: ThemeBackground) => {
    setImageTab(false);
    save({ background: replacementPatch(theme.background, next) });
  };

  // The last background of each type seen here, so switching Image → Gradient → Image brings the
  // uploaded photo (and its blur/dim) back instead of an empty drop zone (UX-11).
  const remembered = useRef<Partial<Record<ThemeBackground['type'], ThemeBackground>>>({});
  remembered.current[theme.background.type] = theme.background;

  const backgroundType = imageTab ? 'image' : theme.background.type;

  return (
    <div className={styles.stack}>
      <ThemePreview />

      <SettingsCard title="Mode and accent" description="Changes apply instantly and are saved automatically.">
        <Field label="Mode">
          <SegmentedControl
            value={theme.mode}
            onValueChange={(mode) => save({ mode })}
            options={[
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'system', label: 'System', icon: Monitor },
            ]}
          />
        </Field>
        <Field label="Accent color">
          <ColorPicker value={theme.accent} onChange={(accent) => save({ accent })} />
        </Field>
      </SettingsCard>

      <SettingsCard title="Background">
        <Field label="Background type">
          <SegmentedControl
            value={backgroundType}
            onValueChange={(type) => {
              if (type === theme.background.type && !imageTab) return;
              const previous = remembered.current[type];
              if (previous && previous.type !== theme.background.type) {
                setBackground(previous);
              } else if (type === 'image') {
                setImageTab(true);
              } else if (type === 'color') {
                const first = theme.background.type === 'gradient' ? theme.background.stops[0]?.color : undefined;
                setBackground({ type: 'color', color: first ?? '#0b4f63' });
              } else {
                setBackground(defaultThemeBackground());
              }
            }}
            options={[
              { value: 'color', label: 'Color', icon: Paintbrush },
              { value: 'gradient', label: 'Gradient', icon: SwatchBook },
              { value: 'image', label: 'Image', icon: ImageIcon },
            ]}
          />
        </Field>

        {backgroundType === 'color' && theme.background.type === 'color' ? (
          <Field label="Background color">
            <ColorPicker value={theme.background.color} onChange={(color) => setBackground({ type: 'color', color })} />
          </Field>
        ) : null}

        {backgroundType === 'gradient' && theme.background.type === 'gradient' ? (
          <GradientBuilder background={theme.background} onChange={setBackground} />
        ) : null}

        {backgroundType === 'image' ? (
          <ImageBackgroundEditor
            background={theme.background.type === 'image' ? theme.background : null}
            onChange={(next) => {
              if (theme.background.type === 'image') save({ background: next });
              else setBackground({ type: 'image', blur: 0, dim: 0.2, ...next } as ThemeBackground);
            }}
          />
        ) : null}
      </SettingsCard>

      <SettingsCard title="Text and layout">
        <Field label="Font">
          <SegmentedControl
            value={theme.font}
            onValueChange={(font) => save({ font })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'serif', label: 'Serif' },
              { value: 'mono', label: 'Mono' },
              { value: 'rounded', label: 'Rounded' },
            ]}
          />
        </Field>
        <Field label="Density">
          <SegmentedControl
            value={theme.density}
            onValueChange={(density) => save({ density })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Field>
        <FieldGrid>
          <Field label="Corner radius">
            <Slider value={theme.radius} min={0} max={24} step={1} onChange={(radius) => save({ radius })} format={(v) => `${v}px`} />
          </Field>
          <Field label="Widget opacity" help="Lower values let more of the background show through.">
            <Slider
              value={theme.widgetOpacity}
              min={0.3}
              max={1}
              step={0.05}
              onChange={(widgetOpacity) => save({ widgetOpacity: Math.round(widgetOpacity * 100) / 100 })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Field>
        </FieldGrid>
      </SettingsCard>

      <div>
        <Button
          variant="ghost"
          icon={RotateCcw}
          onClick={() => {
            setImageTab(false);
            save(null);
          }}
        >
          Reset appearance to defaults
        </Button>
      </div>
    </div>
  );
}

/** A miniature dashboard drawn with the live theme variables. */
function ThemePreview() {
  return (
    <div className={styles.themePreview} aria-hidden="true">
      <div className={styles.themePreviewBackdrop} />
      <div className={styles.previewWidget}>
        <span className={styles.previewTitle}>Calendar</span>
        <span className={styles.previewLine} style={{ width: '80%' }} />
        <span className={styles.previewLine} style={{ width: '60%' }} />
        <span className={styles.previewLine} style={{ width: '70%' }} />
      </div>
      <div className={styles.previewWidget}>
        <span className={styles.previewTitle}>Todoist</span>
        <span className={styles.previewLine} style={{ width: '75%' }} />
        <span className={styles.previewButton}>Add task</span>
      </div>
    </div>
  );
}

type GradientBackground = Extract<ThemeBackground, { type: 'gradient' }>;

function GradientBuilder({ background, onChange }: { background: GradientBackground; onChange(next: GradientBackground): void }) {
  const update = (patch: Partial<GradientBackground>) => onChange({ ...background, ...patch });
  const setStop = (index: number, patch: Partial<GradientStop>) =>
    update({ stops: background.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  const addStop = () => {
    if (background.stops.length >= MAX_STOPS) return;
    const sorted = [...background.stops].sort((a, b) => a.at - b.at);
    // Insert in the middle of the largest gap, with the color of its left neighbour.
    let best = 0;
    let bestGap = -1;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1]!.at - sorted[i]!.at;
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    const left = sorted[best]!;
    const right = sorted[best + 1] ?? left;
    update({ stops: [...background.stops, { color: left.color, at: Math.round((left.at + right.at) / 2) }] });
  };

  const valid = ThemeSchema.shape.background.safeParse(background).success;

  return (
    <div className={styles.stack}>
      <div className={styles.gradientBar} style={{ background: valid ? backdropValue(background) : undefined } as CSSProperties} />
      <Field label="Presets">
        <div className={styles.inlineRow}>
          {GRADIENT_PRESETS.map((preset) => (
            <Button
              key={preset.name}
              size="sm"
              onClick={() => onChange({ type: 'gradient', angle: preset.angle, stops: preset.stops.map((s) => ({ ...s })) })}
            >
              <span
                aria-hidden="true"
                style={{ width: 14, height: 14, borderRadius: 4, background: backdropValue({ type: 'gradient', angle: preset.angle, stops: preset.stops }) }}
              />
              {preset.name}
            </Button>
          ))}
        </div>
      </Field>
      <Field label="Angle">
        <Slider value={background.angle} min={0} max={360} step={5} onChange={(angle) => update({ angle })} format={(v) => `${v}°`} />
      </Field>
      <Field label="Color stops" help={`Between ${MIN_STOPS} and ${MAX_STOPS} colors.`}>
        <ol className={styles.stops}>
          {background.stops.map((stop, index) => (
            <li key={index} className={styles.stop}>
              <ColorPickerPopover label={`Stop ${index + 1} color`} value={stop.color} onChange={(color) => setStop(index, { color })} />
              <Slider
                aria-label={`Stop ${index + 1} position`}
                value={stop.at}
                min={0}
                max={100}
                onChange={(at) => setStop(index, { at })}
                format={(v) => `${v}%`}
              />
              <IconButton
                icon={Trash}
                size="sm"
                aria-label={`Remove stop ${index + 1}`}
                disabled={background.stops.length <= MIN_STOPS}
                onClick={() => update({ stops: background.stops.filter((_, i) => i !== index) })}
              />
            </li>
          ))}
        </ol>
      </Field>
      <div>
        <Button size="sm" icon={Plus} onClick={addStop} disabled={background.stops.length >= MAX_STOPS}>
          Add color stop
        </Button>
      </div>
    </div>
  );
}

type ImageBackground = Extract<ThemeBackground, { type: 'image' }>;

function ImageBackgroundEditor({
  background,
  onChange,
}: {
  background: ImageBackground | null;
  onChange(next: Partial<Omit<ImageBackground, 'type'>> & { uploadId?: string }): void;
}) {
  return (
    <div className={styles.stack}>
      <Field label="Background image">
        <ImageUpload
          value={background?.uploadId ?? null}
          removable={false}
          onChange={(uploadId) => {
            if (uploadId) onChange({ uploadId });
          }}
          hint="Large photos work best. PNG, JPEG, WebP, AVIF or GIF up to 10 MB."
        />
      </Field>
      {background ? (
        <FieldGrid>
          <Field label="Blur">
            <Slider value={background.blur} min={0} max={40} onChange={(blur) => onChange({ blur })} format={(v) => `${v}px`} />
          </Field>
          <Field label="Dim" help="Darken the image so widgets stay readable.">
            <Slider
              value={background.dim}
              min={0}
              max={0.9}
              step={0.05}
              onChange={(dim) => onChange({ dim: Math.round(dim * 100) / 100 })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </Field>
        </FieldGrid>
      ) : null}
    </div>
  );
}
