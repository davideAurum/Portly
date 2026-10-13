/**
 * Frame around every widget (§10.3): header (icon, title, `<WidgetActions>` slot, and in edit
 * mode the drag handle, settings and remove buttons), ErrorBoundary + Suspense (skeleton), and
 * `container-type: inline-size` on the body. Config is parsed with the widget's schema on every
 * read; `setConfig` merges a patch into the latest cached config, validates it and PATCHes the
 * instance (never the whole layout). Unknown widget types render a placeholder; a type this page
 * load cannot run (mail and feeds on the in-browser backend) renders `ServerOnlyNotice`.
 */
import { Suspense, useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, GripVertical, RefreshCw, Settings2, Trash } from 'lucide-react';
import type { WidgetInstance } from '@portly/shared';
import { getCachedWidget, saveWidget } from '../api/profiles.ts';
import { isWidgetTypeAvailable } from '../capabilities.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ServerOnlyNotice } from '../ui/ServerOnlyNotice.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { toastError } from '../ui/toast.ts';
import { getWidgetDefinition, parseWidgetConfig } from '../widgets/registry.ts';
import type { AnyWidgetDefinition } from '../widgets/types.ts';
import { isMoveKey, type MoveKey } from './layout.ts';
import { WidgetFrameContext, type WidgetFrameContextValue } from './WidgetContext.tsx';
import styles from './WidgetFrame.module.css';

export const DRAG_HANDLE_CLASS = 'hb-drag-handle';

export interface WidgetFrameProps {
  instance: WidgetInstance;
  /** Profile the widget belongs to (null for the unsaved default layout). */
  profileId: string | null;
  editMode: boolean;
  onOpenSettings?: (options?: { focus?: string }) => void;
  onRemove?: () => void;
  /** Keyboard move/resize from the drag handle (arrows / Shift+arrows). */
  onKeyboardEdit?: (key: MoveKey, resize: boolean) => void;
}

export function WidgetFrame({ instance, profileId, editMode, onOpenSettings, onRemove, onKeyboardEdit }: WidgetFrameProps) {
  const definition = getWidgetDefinition(instance.type);
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const moveHelpId = useId();

  // Known to this version but not runnable on this page load (in-browser backend: mail, feeds).
  const available = isWidgetTypeAvailable(instance.type);
  const title = definition ? (instance.frame.title ?? definition.title) : 'Unknown widget';
  const Icon = definition?.icon ?? CircleAlert;
  const canOpenSettings = Boolean(definition && available && onOpenSettings && profileId !== null);
  const showHeader = editMode || instance.frame.showHeader || !definition;

  const context = useMemo<WidgetFrameContextValue>(
    () => ({
      instanceId: instance.id,
      title,
      openSettings: (options) => {
        if (canOpenSettings) onOpenSettings?.(options);
      },
      canOpenSettings,
      actionsTarget,
    }),
    [actionsTarget, canOpenSettings, instance.id, onOpenSettings, title],
  );

  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onKeyboardEdit || !isMoveKey(event.key)) return;
    event.preventDefault();
    onKeyboardEdit(event.key, event.shiftKey);
  };

  return (
    <WidgetFrameContext.Provider value={context}>
      <section
        className={styles.frame}
        data-transparent={instance.frame.transparent && !editMode ? 'true' : undefined}
        data-edit={editMode ? 'true' : undefined}
        data-widget-type={instance.type}
        aria-label={title}
      >
        {showHeader ? (
          <header className={[styles.header, editMode ? DRAG_HANDLE_CLASS : ''].filter(Boolean).join(' ')}>
            {editMode ? (
              <>
                <div
                  className={styles.grip}
                  role="button"
                  tabIndex={0}
                  aria-label={`Move ${title}`}
                  aria-describedby={moveHelpId}
                  onKeyDown={onHandleKeyDown}
                >
                  <GripVertical aria-hidden="true" />
                </div>
                <span id={moveHelpId} className="hb-visually-hidden">
                  Drag to move. With the keyboard, use the arrow keys to move and Shift with the arrow keys to resize.
                </span>
              </>
            ) : null}
            <Icon className={styles.icon} aria-hidden="true" />
            <h2 className={styles.title}>{title}</h2>
            <div className={styles.actions} ref={editMode ? undefined : setActionsTarget} data-widget-actions="" />
            {!editMode && canOpenSettings ? (
              <IconButton
                icon={Settings2}
                size="sm"
                aria-label={`${title} settings`}
                className={styles.hoverAction}
                onClick={() => onOpenSettings?.()}
              />
            ) : null}
            {editMode ? (
              <div className={styles.editActions}>
                {canOpenSettings ? <IconButton icon={Settings2} size="sm" aria-label={`${title} settings`} onClick={() => onOpenSettings?.()} /> : null}
                {onRemove ? <IconButton icon={Trash} size="sm" aria-label={`Remove ${title}`} onClick={onRemove} /> : null}
              </div>
            ) : null}
          </header>
        ) : (
          <div className={styles.floatingActions}>
            <div className={styles.actions} ref={setActionsTarget} data-widget-actions="" />
            {canOpenSettings ? (
              <IconButton icon={Settings2} size="sm" aria-label={`${title} settings`} className={styles.hoverAction} onClick={() => onOpenSettings?.()} />
            ) : null}
          </div>
        )}
        <div className={styles.body}>
          {definition && available ? (
            <KnownWidgetBody instance={instance} profileId={profileId} editMode={editMode} definition={definition} />
          ) : definition ? (
            <ServerOnlyNotice feature={definition.title} hint={editMode ? undefined : 'Remove it in edit mode.'} compact={instance.h <= 2} />
          ) : (
            <EmptyState
              icon={CircleAlert}
              title="Unknown widget"
              body={`This version of Portly has no "${instance.type}" widget.${editMode ? '' : ' Remove it in edit mode.'}`}
              compact={instance.h <= 2}
            />
          )}
        </div>
      </section>
    </WidgetFrameContext.Provider>
  );
}

interface KnownWidgetBodyProps {
  instance: WidgetInstance;
  profileId: string | null;
  editMode: boolean;
  definition: AnyWidgetDefinition;
}

function KnownWidgetBody({ instance, profileId, editMode, definition }: KnownWidgetBodyProps) {
  const queryClient = useQueryClient();
  const config: unknown = useMemo(() => parseWidgetConfig(definition, instance.config), [definition, instance.config]);

  /**
   * Resolves once saved. Failures are rolled back and reported with a toast here, so widgets can
   * simply `void setConfig(...)`; the promise never rejects.
   */
  const setConfig = useCallback(
    async (patch: Record<string, unknown>) => {
      // The unsaved default layout has nowhere to store config yet.
      if (profileId === null) return;
      // Merge into the latest cached config so rapid successive patches do not overwrite each other.
      const latest = getCachedWidget(queryClient, profileId, instance.id);
      const base = parseWidgetConfig(definition, latest?.config ?? instance.config) as Record<string, unknown>;
      const next = definition.configSchema.safeParse({ ...base, ...patch });
      if (!next.success) {
        console.error(`Invalid ${definition.type} widget config`, next.error.issues);
        toastError(null, 'These widget settings are not valid.');
        return;
      }
      try {
        await saveWidget(queryClient, profileId, instance.id, { config: next.data });
      } catch {
        // saveWidget rolled back the optimistic update and showed a toast.
      }
    },
    [definition, instance.config, instance.id, profileId, queryClient],
  );

  const Widget = definition.Component;
  return (
    <ErrorBoundary
      fallback={(_error, reset) => (
        <EmptyState
          icon={CircleAlert}
          title="This widget crashed"
          body="The rest of the page still works."
          compact={instance.h <= 2}
          action={
            <Button size="sm" icon={RefreshCw} onClick={reset}>
              Retry
            </Button>
          }
        />
      )}
    >
      <Suspense
        fallback={
          <div className={styles.loading} role="status" aria-label="Loading">
            <SkeletonLines lines={Math.min(4, Math.max(1, instance.h - 1))} />
          </div>
        }
      >
        <Widget instanceId={instance.id} config={config} setConfig={setConfig} size={{ w: instance.w, h: instance.h }} editMode={editMode} />
      </Suspense>
    </ErrorBoundary>
  );
}
