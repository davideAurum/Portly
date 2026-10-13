/**
 * The launch pad in edit mode: group management and drag ordering within/across groups with
 * @dnd-kit (pointer + keyboard) through `POST /api/bookmarks/:id/move` (optimistic, rolled back on
 * error). Its own chunk (PERF-1): the view board never needs @dnd-kit, so a new tab does not load
 * it; Widget.tsx preloads this module when the browser is idle.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FolderPlus, Pencil, Plus, Trash } from 'lucide-react';
import type { Bookmark, BookmarkGroup } from '@portly/shared';
import { useMoveBookmark, useUpdateGroup } from '../../api/bookmarks.ts';
import { Button, IconButton } from '../../ui/index.ts';
import type { LaunchpadConfig } from './index.ts';
import { groupSpan, visibleGroups } from './groups.ts';
import { ungroupedFirst, useUngroupedId } from './ungrouped.ts';
import { BoardFrame, GroupShell, TileBody, boardStyle, showsTitle } from './tiles.tsx';
import styles from './Launchpad.module.css';

/** After a delete in edit mode, the tiles reflow: their buttons ignore clicks this long (UX-6). */
export const DELETE_COOLDOWN_MS = 400;
const GROUP_PREFIX = 'group:';

export interface EditBoardProps {
  /** Every group (the ones this launch pad shows are picked by `config.groupIds`). */
  allGroups: BookmarkGroup[];
  config: LaunchpadConfig;
  onAdd(groupId: string): void;
  onEdit(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
  onEditGroup(group: BookmarkGroup): void;
  onDeleteGroup(group: BookmarkGroup): void;
  onNewGroup(): void;
}

type Arrangement = Record<string, string[]>;

function arrangementOf(groups: readonly BookmarkGroup[]): Arrangement {
  return Object.fromEntries(groups.map((g) => [g.id, g.bookmarks.map((b) => b.id)]));
}

export default function EditBoard({ allGroups, config, onAdd, onEdit, onDelete, onEditGroup, onDeleteGroup, onNewGroup }: EditBoardProps) {
  const move = useMoveBookmark();
  const updateGroup = useUpdateGroup();
  // Right after a delete the next tile slides under the pointer: a quick second click must not
  // delete (or edit) that one too.
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), DELETE_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Memoized: `base` changing is what ends a drop's draft arrangement (see the effect below).
  const ungroupedId = useUngroupedId(allGroups);
  const groups = useMemo(() => ungroupedFirst(visibleGroups(allGroups, config), ungroupedId), [allGroups, config, ungroupedId]);
  const base = useMemo(() => arrangementOf(groups), [groups]);
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.bookmarks.map((b) => [b.id, b] as const))), [groups]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  // During a drag — and after a drop until the cache reflects it — the board shows this arrangement.
  const [draft, setDraft] = useState<Arrangement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dropBase = useRef<Arrangement | null>(null);
  /** Pointer drags end with a click on the tile; it must not open the edit dialog. */
  const suppressClickUntil = useRef(0);
  const items = draft ?? base;

  useEffect(() => {
    if (dropBase.current !== null && dropBase.current !== base) {
      dropBase.current = null;
      setDraft(null);
    }
  }, [base]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = (id: UniqueIdentifier, arrangement: Arrangement = items): string | null => {
    const key = String(id);
    if (key.startsWith(GROUP_PREFIX)) return key.slice(GROUP_PREFIX.length);
    for (const [groupId, ids] of Object.entries(arrangement)) if (ids.includes(key)) return groupId;
    return null;
  };

  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    if (hits.length > 0) {
      const onItems = hits.filter((hit) => !String(hit.id).startsWith(GROUP_PREFIX));
      return onItems.length > 0 ? onItems : hits;
    }
    return closestCorners(args);
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    dropBase.current = null;
    setActiveId(String(active.id));
    setDraft(base);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setDraft((current) => {
      const arrangement = current ?? base;
      const from = containerOf(active.id, arrangement);
      const to = containerOf(over.id, arrangement);
      if (!from || !to || from === to) return arrangement;
      const source = arrangement[from]!.filter((id) => id !== active.id);
      const target = [...arrangement[to]!];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex >= 0 ? overIndex : target.length, 0, String(active.id));
      return { ...arrangement, [from]: source, [to]: target };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    suppressClickUntil.current = Date.now() + 300;
    const id = String(active.id);
    let arrangement = draftRef.current ?? base;
    const container = containerOf(id, arrangement);
    if (over && container) {
      const overContainer = containerOf(over.id, arrangement);
      if (overContainer === container && !String(over.id).startsWith(GROUP_PREFIX)) {
        const list = arrangement[container]!;
        const from = list.indexOf(id);
        const to = list.indexOf(String(over.id));
        if (from !== to && to >= 0) arrangement = { ...arrangement, [container]: arrayMove(list, from, to) };
      }
    }
    const origin = containerOf(id, base);
    const finalGroup = containerOf(id, arrangement);
    setActiveId(null);
    if (!over || !origin || !finalGroup) {
      setDraft(null);
      return;
    }
    const index = arrangement[finalGroup]!.indexOf(id);
    if (finalGroup === origin && base[origin]!.indexOf(id) === index) {
      setDraft(null);
      return;
    }
    // Keep showing the dropped arrangement until the optimistic cache update (or a rollback) lands.
    dropBase.current = base;
    setDraft(arrangement);
    move.mutate({ id, groupId: finalGroup, index });
  };

  const onDragCancel = () => {
    setActiveId(null);
    setDraft(null);
  };

  const deleteBookmark = (bookmark: Bookmark) => {
    setCooldown(true);
    onDelete(bookmark);
  };

  const titleOf = (id: UniqueIdentifier) => byId.get(String(id))?.title ?? 'bookmark';
  const describeTarget = (id: UniqueIdentifier) => {
    const key = String(id);
    if (key.startsWith(GROUP_PREFIX)) return `group ${groupById.get(key.slice(GROUP_PREFIX.length))?.name ?? ''}`;
    const group = containerOf(key);
    const position = group ? (items[group]?.indexOf(key) ?? 0) + 1 : 0;
    return `position ${position} in ${groupById.get(group ?? '')?.name ?? 'the group'}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) => (over ? `${titleOf(active.id)} is over ${describeTarget(over.id)}.` : `${titleOf(active.id)} is no longer over a group.`),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${titleOf(active.id)} at ${describeTarget(over.id)}.` : `Dropped ${titleOf(active.id)}.`),
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  };

  const activeBookmark = activeId ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: 'To move a bookmark, press Space or Enter, move it with the arrow keys (also into other groups), then press Space or Enter to drop it. Escape cancels.',
        },
      }}
    >
      <BoardFrame config={config} editMode>
        {groups.map((group) => (
          <EditGroup
            key={group.id}
            group={group}
            ids={items[group.id] ?? []}
            byId={byId}
            config={config}
            activeId={activeId}
            cooldown={cooldown}
            onToggle={() => updateGroup.mutate({ id: group.id, patch: { collapsed: !group.collapsed } })}
            onAdd={() => onAdd(group.id)}
            onEdit={(bookmark) => {
              if (Date.now() >= suppressClickUntil.current) onEdit(bookmark);
            }}
            onDelete={deleteBookmark}
            onEditGroup={group.id === ungroupedId ? undefined : () => onEditGroup(group)}
            onDeleteGroup={() => onDeleteGroup(group)}
          />
        ))}
        <div className={styles.boardFooter}>
          <Button size="sm" variant="ghost" icon={FolderPlus} onClick={onNewGroup}>
            New group
          </Button>
        </div>
      </BoardFrame>
      {/* Portalled: a fixed-position overlay inside the grid's transformed items would be offset. */}
      {createPortal(
        <DragOverlay dropAnimation={null} zIndex={1000}>
          {activeBookmark ? (
            <div className={styles.overlay} data-style={config.style} data-density={config.listDensity} data-detail={config.listDetailPlacement} data-lp-overlay="" style={boardStyle(config)}>
              <TileBody bookmark={activeBookmark} config={config} />
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

interface EditGroupProps {
  group: BookmarkGroup;
  ids: string[];
  byId: ReadonlyMap<string, Bookmark>;
  config: LaunchpadConfig;
  activeId: string | null;
  /** Tile buttons briefly ignore clicks after a delete. */
  cooldown: boolean;
  onToggle(): void;
  onAdd(): void;
  onEdit(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
  /** Absent for "No group" (it is not renamed). */
  onEditGroup?(): void;
  onDeleteGroup(): void;
}

function EditGroup({ group, ids, byId, config, activeId, cooldown, onToggle, onAdd, onEdit, onDelete, onEditGroup, onDeleteGroup }: EditGroupProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${GROUP_PREFIX}${group.id}` });
  const bookmarks = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return (
    <GroupShell
      group={group}
      showHeader
      span={groupSpan(config, group.id)}
      onToggle={onToggle}
      sectionRef={setNodeRef}
      over={isOver}
      actions={
        <>
          <IconButton icon={Plus} size="sm" aria-label={`Add bookmark to ${group.name}`} onClick={onAdd} />
          {onEditGroup ? <IconButton icon={Pencil} size="sm" aria-label={`Edit group ${group.name}`} onClick={onEditGroup} /> : null}
          <IconButton icon={Trash} size="sm" aria-label={`Delete group ${group.name}`} onClick={onDeleteGroup} />
        </>
      }
    >
      {(bodyId) => (
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <ul className={styles.items} id={bodyId} aria-label={group.name}>
            {bookmarks.map((bookmark) => (
              <SortableTile
                key={bookmark.id}
                bookmark={bookmark}
                config={config}
                dragging={activeId === bookmark.id}
                disabled={cooldown}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
            <li className={styles.addItem}>
              <button type="button" className={styles.addTile} onClick={onAdd} aria-label={`New bookmark in ${group.name}`} disabled={cooldown}>
                <span className={styles.addIcon}>
                  <Plus aria-hidden="true" />
                </span>
                {showsTitle(config) ? <span className={styles.label}>Add</span> : null}
              </button>
            </li>
          </ul>
        </SortableContext>
      )}
    </GroupShell>
  );
}

interface SortableTileProps {
  bookmark: Bookmark;
  config: LaunchpadConfig;
  dragging: boolean;
  /** Briefly true after a delete: the buttons ignore clicks while the tiles reflow. */
  disabled: boolean;
  onEdit(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
}

function SortableTile({ bookmark, config, dragging, disabled, onEdit, onDelete }: SortableTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: bookmark.id });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <li ref={setNodeRef} className={styles.item} style={style} data-bookmark-id={bookmark.id} data-dragging={dragging ? 'true' : undefined}>
      <div
        {...attributes}
        {...listeners}
        className={styles.tile}
        data-sortable="true"
        aria-label={`${bookmark.title}. Drag to reorder`}
        onClick={(event) => {
          if (event.detail > 0) onEdit(bookmark);
        }}
      >
        <TileBody bookmark={bookmark} config={config} />
      </div>
      <span className={styles.tileActions}>
        <IconButton
          icon={Pencil}
          size="sm"
          variant="secondary"
          className={styles.tileAction}
          aria-label={`Edit ${bookmark.title}`}
          tooltip={false}
          disabled={disabled}
          onClick={() => onEdit(bookmark)}
        />
        <IconButton
          icon={Trash}
          size="sm"
          variant="secondary"
          className={styles.tileAction}
          aria-label={`Delete ${bookmark.title}`}
          tooltip={false}
          disabled={disabled}
          onClick={() => onDelete(bookmark)}
        />
      </span>
    </li>
  );
}
