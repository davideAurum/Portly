/**
 * Per-widget settings (§10.2): frame options (title, header, transparent background) plus the
 * widget's own Settings component. Every change is previewed live on the dashboard (the dialog
 * is a side sheet so the widget stays visible); Save sends one
 * `PATCH /widgets/:instanceId {config, frame}`, Cancel discards the preview.
 */
import { Suspense, useEffect, useId, useState } from 'react';
import { GRID_COLUMNS, type WidgetFrame, type WidgetInstance } from '@homebase/shared';
import { Button } from '../ui/Button.tsx';
import { Dialog } from '../ui/Dialog.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { Field } from '../ui/Field.tsx';
import { Input } from '../ui/Input.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { Switch } from '../ui/Toggles.tsx';
import { parseWidgetConfig } from '../widgets/registry.ts';
import type { AnyWidgetDefinition } from '../widgets/types.ts';
import styles from './Grid.module.css';

export const MAX_WIDGET_TITLE = 80;

export interface WidgetDraft {
  config: unknown;
  frame: WidgetFrame;
}

export interface WidgetSettingsDialogProps {
  instance: WidgetInstance;
  definition: AnyWidgetDefinition;
  onClose(): void;
  /** Live preview of the draft (null clears it). */
  onPreview(draft: WidgetDraft | null): void;
  /** Persists the draft; the dialog closes when it resolves. */
  onSave(draft: WidgetDraft): Promise<void>;
  /** Field to start in (see `openSettings({focus})`), e.g. the weather widget's location search. */
  focus?: string | null;
}

/** Focuses the widget-settings field named `focus` once the (lazily loaded) settings show it. */
function focusSettingsField(container: HTMLElement | null, focus: string, deadline: number): void {
  const target = container?.querySelector<HTMLElement>(`[data-settings-focus="${CSS.escape(focus)}"]`);
  const field = target?.matches('input, textarea, select, button') ? target : target?.querySelector<HTMLElement>('input, textarea, select');
  if (field) {
    field.scrollIntoView({ block: 'center' });
    field.focus();
    return;
  }
  if (Date.now() < deadline) requestAnimationFrame(() => focusSettingsField(container, focus, deadline));
}

export function WidgetSettingsDialog({ instance, definition, onClose, onPreview, onSave, focus = null }: WidgetSettingsDialogProps) {
  const [config, setConfig] = useState<unknown>(() => parseWidgetConfig(definition, instance.config));
  const [title, setTitle] = useState(instance.frame.title ?? '');
  const [showHeader, setShowHeader] = useState(instance.frame.showHeader);
  const [transparent, setTransparent] = useState(instance.frame.transparent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const trimmedTitle = title.trim();
  const titleError = trimmedTitle.length > MAX_WIDGET_TITLE ? `Keep the title under ${MAX_WIDGET_TITLE} characters.` : null;
  const frame: WidgetFrame = {
    ...(trimmedTitle ? { title: trimmedTitle } : {}),
    showHeader,
    transparent,
  };

  // Live preview of every change; cleared when the dialog goes away.
  const frameKey = JSON.stringify(frame);
  useEffect(() => {
    onPreview({ config, frame: JSON.parse(frameKey) as WidgetFrame });
  }, [config, frameKey, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);

  const save = async () => {
    if (titleError) return;
    const parsed = definition.configSchema.safeParse(config);
    if (!parsed.success) {
      setError('Some settings are not valid. Check the highlighted fields.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ config: parsed.data, frame });
      onClose();
    } catch {
      // saveWidget already showed a toast; keep the dialog open.
    } finally {
      setSaving(false);
    }
  };

  const Settings = definition.Settings;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={`${instance.frame.title ?? definition.title} settings`}
      description="Changes preview on your dashboard as you make them."
      placement="side"
      onOpenAutoFocus={
        focus
          ? (event) => {
              // Start in the requested field (not on the Close button) once it has rendered.
              event.preventDefault();
              focusSettingsField(event.currentTarget as HTMLElement, focus, Date.now() + 2000);
            }
          : undefined
      }
      // Keep the widget being edited visible next to the sheet.
      side={instance.x + instance.w / 2 > GRID_COLUMNS / 2 ? 'left' : 'right'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={titleError !== null}>
            Save
          </Button>
        </>
      }
    >
      <form
        className={styles.settingsForm}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <section className={styles.settingsSection} aria-labelledby={`${headingId}-frame`}>
          <h3 id={`${headingId}-frame`} className={styles.settingsHeading}>
            Frame
          </h3>
          <Field label="Title" help={`Leave empty to use "${definition.title}".`} error={titleError}>
            <Input value={title} placeholder={definition.title} onChange={(event) => setTitle(event.currentTarget.value)} maxLength={120} />
          </Field>
          <Switch label="Show header" description="Icon, title and widget buttons." checked={showHeader} onCheckedChange={setShowHeader} />
          <Switch
            label="Transparent background"
            description="Let the page background show through."
            checked={transparent}
            onCheckedChange={setTransparent}
          />
        </section>
        <section className={styles.settingsSection} aria-labelledby={`${headingId}-own`}>
          <h3 id={`${headingId}-own`} className={styles.settingsHeading}>
            {definition.title}
          </h3>
          {Settings ? (
            <ErrorBoundary fallback={() => <p className={styles.settingsNote}>These settings could not be loaded.</p>}>
              <Suspense fallback={<SkeletonLines lines={4} />}>
                <Settings value={config} onChange={setConfig} />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <p className={styles.settingsNote}>This widget has no other settings.</p>
          )}
        </section>
        {error ? (
          <p className={styles.settingsError} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
