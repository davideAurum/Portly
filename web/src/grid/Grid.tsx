/**
 * The dashboard grid (§10.2): 12 columns on react-grid-layout v2 (rowHeight 40, margin 12).
 * In edit mode widgets drag by their header (`.hb-drag-handle`) and resize from any corner or edge;
 * changed positions are saved with a debounced `PUT /positions` (flushed when edit mode ends),
 * config/frame changes go through `PATCH /widgets/:instanceId` — never whole-layout writes.
 * Below 768 px widgets stack full-width in (y, x) order and editing is disabled.
 */
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ReactGridLayout, { useContainerWidth, type Layout as GridLayoutValue } from 'react-grid-layout';
import { useQueryClient } from '@tanstack/react-query';
import { Check, LayoutGrid, Plus } from 'lucide-react';
import type { Layout, WidgetInstance, WidgetPosition } from '@portly/shared';
import { qk } from '../api/keys.ts';
import { getCapabilities } from '../capabilities.ts';
import { applyPositions, saveWidget, savePositions, updateCachedLayout, useAddWidget, useRemoveWidget } from '../api/profiles.ts';
import { useDebouncedCallback } from '../lib/useDebouncedCallback.ts';
import { useIsNarrow } from '../lib/useMediaQuery.ts';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { reserveToastSpace, toast, toastError } from '../ui/toast.ts';
import { getWidgetDefinition, stackSizingOf } from '../widgets/registry.ts';
import { AddWidgetDialog } from './AddWidgetDialog.tsx';
import { useEditMode } from './editMode.tsx';
import { GRID_GAP, ROW_HEIGHT, keyboardEdit, positionsChanged, stackOrder, toGridItems, toPositions, type MoveKey } from './layout.ts';
import { DRAG_HANDLE_CLASS, WidgetFrame } from './WidgetFrame.tsx';
import { WidgetSettingsDialog, type WidgetDraft } from './WidgetSettingsDialog.tsx';
import styles from './Grid.module.css';

/** How long a newly added widget is highlighted. */
export const NEW_WIDGET_HIGHLIGHT_MS = 1600;
const NEW_WIDGET_SCROLL_DELAY_MS = 150;

const GRID_CONFIG = { cols: 12, rowHeight: ROW_HEIGHT, margin: [GRID_GAP, GRID_GAP] as const };
/** Empty-profile hint: names only widgets this page load can add (no mail on the in-browser backend). */
function emptyProfileBody(): string {
  return getCapabilities().mail ? 'Add a search box, bookmarks, your calendar, mail and more.' : 'Add a search box, bookmarks, your calendar, weather and more.';
}
const DRAG_CANCEL = 'input,textarea,select,button,a,[data-no-grid-drag]';
/** Resize from every corner and edge, not just the bottom-right corner. */
export const RESIZE_HANDLES = ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'] as const;
export const POSITIONS_DEBOUNCE_MS = 500;

export interface GridProps {
  layout: Layout;
  /** Profile the layout belongs to (null for the unsaved default layout). */
  profileId: string | null;
}

interface Preview {
  instanceId: string;
  draft: WidgetDraft;
}

export function Grid({ layout, profileId }: GridProps) {
  const client = useQueryClient();
  const { editMode, addWidgetOpen, setAddWidgetOpen, setEditMode } = useEditMode();
  const narrow = useIsNarrow();
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [removing, setRemoving] = useState<WidgetInstance | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const addWidget = useAddWidget(profileId);
  const removeWidget = useRemoveWidget(profileId);
  const knownIds = useRef<Set<string> | null>(null);

  const items = layout.items;
  const effectiveItems = useMemo(
    () =>
      preview
        ? items.map((item) => (item.id === preview.instanceId ? { ...item, config: preview.draft.config, frame: preview.draft.frame } : item))
        : items,
    [items, preview],
  );

  // --- Positions -----------------------------------------------------------------------------

  const persistPositions = useDebouncedCallback((targetProfile: string, positions: WidgetPosition[]) => {
    savePositions(targetProfile, positions).catch((error: unknown) => {
      toastError(error, 'The layout could not be saved.');
      void client.invalidateQueries({ queryKey: qk.profiles() });
    });
  }, POSITIONS_DEBOUNCE_MS);

  const commitPositions = useCallback(
    (positions: WidgetPosition[]) => {
      if (profileId === null || !positionsChanged(items, positions)) return;
      // A profiles refetch in flight (e.g. after adding a widget) would put the old positions back.
      void client.cancelQueries({ queryKey: qk.profiles() });
      updateCachedLayout(client, profileId, (current) => applyPositions(current, positions));
      persistPositions(profileId, positions);
    },
    [client, items, persistPositions, profileId],
  );

  // Leaving edit mode saves immediately.
  useEffect(() => {
    if (!editMode) persistPositions.flush();
  }, [editMode, persistPositions]);

  // So does switching profiles: a change the next profile's grid reports within the debounce
  // window would otherwise replace this profile's pending save.
  useEffect(() => () => persistPositions.flush(), [persistPositions, profileId]);

  // The edit toolbar is fixed at the bottom; toasts move up while it is shown.
  useEffect(() => (editMode ? reserveToastSpace() : undefined), [editMode]);

  const onLayoutChange = useCallback(
    (next: GridLayoutValue) => {
      if (editMode) commitPositions(toPositions(next));
    },
    [commitPositions, editMode],
  );

  const onKeyboardEdit = useCallback(
    (item: WidgetInstance, key: MoveKey, resize: boolean) => {
      const positions = keyboardEdit(items, item.id, key, resize);
      if (!positions) return;
      commitPositions(positions);
      const moved = positions.find((p) => p.id === item.id);
      const name = item.frame.title ?? getWidgetDefinition(item.type)?.title ?? 'Widget';
      if (moved) {
        setAnnouncement(
          resize
            ? `${name} resized to ${moved.w} columns by ${moved.h} rows.`
            : `${name} moved to column ${moved.x + 1}, row ${moved.y + 1}.`,
        );
      }
    },
    [commitPositions, items],
  );

  // --- Add / remove / settings -----------------------------------------------------------------

  const onAdd = useCallback(
    async (type: string) => {
      knownIds.current = new Set(items.map((i) => i.id));
      await addWidget.mutateAsync({ type });
      toast.success(`${getWidgetDefinition(type)?.title ?? 'Widget'} added.`);
    },
    [addWidget, items],
  );

  const addedTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** The widget just added: highlighted briefly so it is easy to spot (UX-6). */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // Scroll a newly added widget into view once it arrives from the server.
  useEffect(() => {
    const known = knownIds.current;
    if (!known) return;
    const added = items.find((i) => !known.has(i.id));
    if (!added) return;
    knownIds.current = null;
    setJustAdded(added.id);
    // scroll-margin (Grid.module.css) keeps it clear of the edit toolbar. The scroll waits until
    // the Add widget dialog has closed and handed focus back to its button (that focus change
    // would cancel a smooth scroll already running), and looks the element up then (react-grid-
    // layout may have re-mounted it). Timers survive later `items` updates; cleared on unmount.
    const reveal = () => {
      const node = [...document.querySelectorAll<HTMLElement>('[data-instance-id]')].find((el) => el.dataset.instanceId === added.id);
      // Instant: a smooth scroll is cancelled by the focus changes and re-layout that follow an add.
      node?.scrollIntoView?.({ block: 'nearest' });
    };
    addedTimers.current.push(
      setTimeout(reveal, NEW_WIDGET_SCROLL_DELAY_MS),
      // Again once the grid has grown to its new height (the first scroll may have been clamped).
      setTimeout(reveal, NEW_WIDGET_SCROLL_DELAY_MS * 4),
      setTimeout(() => setJustAdded((current) => (current === added.id ? null : current)), NEW_WIDGET_HIGHLIGHT_MS),
    );
  }, [items]);
  useEffect(() => () => addedTimers.current.forEach(clearTimeout), []);

  const settingsInstance = settingsFor ? items.find((i) => i.id === settingsFor) : undefined;
  const settingsDefinition = settingsInstance ? getWidgetDefinition(settingsInstance.type) : undefined;

  const onPreview = useCallback(
    (draft: WidgetDraft | null) => {
      setPreview(draft && settingsFor ? { instanceId: settingsFor, draft } : null);
    },
    [settingsFor],
  );

  const onSaveSettings = useCallback(
    async (draft: WidgetDraft) => {
      if (profileId === null || !settingsFor) return;
      await saveWidget(client, profileId, settingsFor, {
        config: draft.config,
        frame: { title: draft.frame.title ?? null, showHeader: draft.frame.showHeader, transparent: draft.frame.transparent },
      });
    },
    [client, profileId, settingsFor],
  );

  // --- Rendering -------------------------------------------------------------------------------

  const frameFor = (item: WidgetInstance) => (
    <WidgetFrame
      instance={item}
      profileId={profileId}
      editMode={editMode}
      onOpenSettings={
        profileId === null
          ? undefined
          : (options) => {
              setSettingsFocus(options?.focus ?? null);
              setSettingsFor(item.id);
            }
      }
      onRemove={profileId === null ? undefined : () => setRemoving(item)}
      onKeyboardEdit={(key, resize) => onKeyboardEdit(item, key, resize)}
    />
  );

  const removingTitle = removing ? (removing.frame.title ?? getWidgetDefinition(removing.type)?.title ?? 'this widget') : '';

  return (
    <div className={styles.wrap} data-edit={editMode ? 'true' : undefined} data-testid="widget-grid">
      {items.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            icon={LayoutGrid}
            title="This profile has no widgets yet"
            body={emptyProfileBody()}
            action={
              profileId !== null && !narrow ? (
                <Button variant="primary" icon={Plus} onClick={() => setAddWidgetOpen(true)}>
                  Add widget
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : narrow ? (
        <div className={styles.stack}>
          {stackOrder(effectiveItems).map((item) => (
            <div
              key={item.id}
              className={styles.stackItem}
              data-instance-id={item.id}
              data-stack-sizing={stackSizingOf(item.type, item.config)}
              data-just-added={item.id === justAdded ? 'true' : undefined}
              style={{ '--hb-stack-rows': String(item.h) } as CSSProperties}
            >
              {frameFor(item)}
            </div>
          ))}
        </div>
      ) : (
        <MeasuredGrid items={effectiveItems} editMode={editMode} onLayoutChange={onLayoutChange} renderItem={frameFor} justAdded={justAdded} />
      )}

      {editMode ? (
        <div className={styles.editBar} role="region" aria-label="Edit mode">
          <p className={styles.editHint}>Drag widgets by their header, resize from any edge or corner.</p>
          <Button size="sm" icon={Plus} onClick={() => setAddWidgetOpen(true)}>
            Add widget
          </Button>
          <Button size="sm" variant="primary" icon={Check} onClick={() => setEditMode(false)}>
            Done
          </Button>
        </div>
      ) : null}

      <p className="hb-visually-hidden" aria-live="polite">
        {announcement}
      </p>

      <AddWidgetDialog open={addWidgetOpen} onOpenChange={setAddWidgetOpen} onAdd={onAdd} />

      {settingsInstance && settingsDefinition ? (
        <WidgetSettingsDialog
          key={settingsInstance.id}
          instance={settingsInstance}
          focus={settingsFocus}
          definition={settingsDefinition}
          onClose={() => setSettingsFor(null)}
          onPreview={onPreview}
          onSave={onSaveSettings}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removingTitle}?`}
        description="The widget and its settings are removed from this profile. Your accounts and data are not affected."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing) await removeWidget.mutateAsync(removing.id);
        }}
      />
    </div>
  );
}

interface MeasuredGridProps {
  items: WidgetInstance[];
  editMode: boolean;
  onLayoutChange(layout: GridLayoutValue): void;
  renderItem(item: WidgetInstance): ReactNode;
  justAdded: string | null;
}

/** react-grid-layout sized to its container (rendered once the width is known). */
function MeasuredGrid({ items, editMode, onLayoutChange, renderItem, justAdded }: MeasuredGridProps) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const gridItems = useMemo(() => toGridItems(items), [items]);
  const dragConfig = useMemo(() => ({ enabled: editMode, handle: `.${DRAG_HANDLE_CLASS}`, cancel: DRAG_CANCEL }), [editMode]);
  const resizeConfig = useMemo(() => ({ enabled: editMode, handles: RESIZE_HANDLES }), [editMode]);

  return (
    <div ref={containerRef} className={styles.gridContainer}>
      {mounted ? (
        <ReactGridLayout
          width={width}
          layout={gridItems}
          gridConfig={GRID_CONFIG}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          onLayoutChange={onLayoutChange}
          className={styles.rgl}
        >
          {items.map((item) => (
            <div key={item.id} className={styles.item} data-instance-id={item.id} data-just-added={item.id === justAdded ? 'true' : undefined}>
              {renderItem(item)}
            </div>
          ))}
        </ReactGridLayout>
      ) : null}
    </div>
  );
}
