/**
 * Launch pad widget (§10.8): bookmark groups as tiles or a list (icon size, labels, columns),
 * group headers with color and collapse, add/edit dialog with site-meta autofill, delete with
 * Undo, and — in edit mode — group management and drag ordering (EditBoard.tsx). Links open in
 * the current tab unless `general.openLinksInNewTab`; Ctrl/middle click opens a new tab (native
 * anchors). Outside edit mode each tile has a menu (right-click, long press, Shift+F10 or its "⋯"
 * button) with Edit, Move to and Delete (with Undo).
 *
 * Only the view board is in this chunk (PERF-1): the edit board (@dnd-kit) and the dialogs are
 * separate chunks, loaded when the browser is idle after the first render (or when first needed).
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, FolderInput, Import, LayoutGrid, Pencil, Plus, Trash } from 'lucide-react';
import type { Bookmark, BookmarkGroup } from '@homebase/shared';
import { restoreBookmark, useBookmarks, useDeleteBookmark, useMoveBookmark, useUpdateGroup } from '../../api/bookmarks.ts';
import { useSettings } from '../../api/settings.ts';
import { getCapabilities } from '../../capabilities.ts';
import { WidgetActions } from '../../grid/WidgetContext.tsx';
import { linkProps, safeHref } from '../../lib/openUrl.ts';
import { Button, EmptyState, IconButton, QueryView, Skeleton, StaleIndicator, toastUndo } from '../../ui/index.ts';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../../ui/Menu.tsx';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetProps } from '../types.ts';
import type { LaunchpadConfig } from './index.ts';
import { groupSpan, visibleGroups } from './groups.ts';
import { ungroupedFirst, useUngroupedId } from './ungrouped.ts';
import { BoardFrame, GroupShell, TileBody, hostLabel, showsTitle } from './tiles.tsx';
import styles from './Launchpad.module.css';

const EditBoard = lazyWithPreload(() => import('./EditBoard.tsx'));
const BookmarkDialog = lazyWithPreload(() => import('./BookmarkDialog.tsx').then((m) => ({ default: m.BookmarkDialog })));
const GroupDialog = lazyWithPreload(() => import('./GroupDialog.tsx').then((m) => ({ default: m.GroupDialog })));
const DeleteGroupDialog = lazyWithPreload(() => import('./GroupDialog.tsx').then((m) => ({ default: m.DeleteGroupDialog })));

const LAZY_PARTS = [EditBoard, BookmarkDialog, GroupDialog, DeleteGroupDialog];
let lazyPartsLoaded = false;
let lazyPartsUsers = 0;
let cancelLazyParts: (() => void) | null = null;

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 1000);
  return () => clearTimeout(timer);
}

/**
 * Loads the edit board and the dialogs once, when the browser is idle after the first paint, so
 * entering edit mode or opening a dialog does not wait for a chunk. Cancelled while no launch pad
 * is mounted.
 */
function usePreloadLazyParts() {
  useEffect(() => {
    lazyPartsUsers += 1;
    if (!lazyPartsLoaded && !cancelLazyParts) {
      cancelLazyParts = whenIdle(() => {
        cancelLazyParts = null;
        lazyPartsLoaded = true;
        for (const part of LAZY_PARTS) {
          part.preload().catch(() => {
            lazyPartsLoaded = false; // loaded on demand instead (and retried by the next mount)
          });
        }
      });
    }
    return () => {
      lazyPartsUsers -= 1;
      if (lazyPartsUsers === 0 && cancelLazyParts) {
        cancelLazyParts();
        cancelLazyParts = null;
      }
    };
  }, []);
}

/** A touch held this long opens a tile's menu. */
const LONG_PRESS_MS = 500;

type DialogState =
  | { kind: 'add'; groupId: string | null }
  | { kind: 'edit'; bookmark: Bookmark }
  | { kind: 'group'; group: BookmarkGroup | null }
  | { kind: 'delete-group'; group: BookmarkGroup }
  | null;

type DialogFamily = 'bookmark' | 'group' | 'delete-group';
const familyOf = (dialog: NonNullable<DialogState>): DialogFamily =>
  dialog.kind === 'add' || dialog.kind === 'edit' ? 'bookmark' : dialog.kind === 'group' ? 'group' : 'delete-group';

export default function LaunchpadWidget({ config, editMode, size }: WidgetProps<LaunchpadConfig>) {
  const query = useBookmarks();
  const settings = useSettings();
  const client = useQueryClient();
  const remove = useDeleteBookmark();
  const [dialog, setDialogState] = useState<DialogState>(null);
  // A dialog is mounted from its first opening on (so it can animate closed), not before.
  const [mounted, setMounted] = useState<ReadonlySet<DialogFamily>>(() => new Set());
  const setDialog = (next: DialogState) => {
    setDialogState(next);
    if (next) {
      const family = familyOf(next);
      setMounted((current) => (current.has(family) ? current : new Set([...current, family])));
    }
  };

  usePreloadLazyParts();

  const deleteBookmark = (bookmark: Bookmark) => {
    remove.mutate(bookmark, {
      onSuccess: () => toastUndo(`Deleted “${bookmark.title}”`, { onUndo: () => restoreBookmark(client, bookmark) }),
    });
  };
  const importHref = safeHref('#/settings/bookmarks');
  const allGroups = query.data?.groups ?? [];
  const defaultGroupId = settings.data?.bookmarks.defaultGroupId ?? null;

  const addTarget = (groups: readonly BookmarkGroup[]) =>
    groups.find((g) => g.id === defaultGroupId)?.id ?? groups[0]?.id ?? allGroups.find((g) => g.id === defaultGroupId)?.id ?? allGroups[0]?.id ?? null;

  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const edit = (bookmark: Bookmark) => setDialog({ kind: 'edit', bookmark });

  return (
    <>
      <WidgetActions>
        {query.data && query.isError ? <StaleIndicator updatedAt={query.dataUpdatedAt} error={query.error} onRetry={() => void query.refetch()} /> : null}
        {query.data ? (
          <IconButton icon={Plus} size="sm" aria-label="Add bookmark" onClick={() => setDialog({ kind: 'add', groupId: addTarget(visibleGroups(allGroups, config)) })} />
        ) : null}
      </WidgetActions>
      <QueryView
        query={query}
        compact={size.h <= 3}
        skeleton={<TilesSkeleton />}
        isEmpty={(data) => !editMode && visibleGroups(data.groups, config).every((g) => g.bookmarks.length === 0)}
        empty={
          <EmptyState
            icon={LayoutGrid}
            title="No bookmarks yet"
            body={
              getCapabilities().browserBookmarkImport
                ? 'Add your favourite sites, or bring them over from Chrome, Edge or an exported HTML file.'
                : 'Add your favourite sites, or bring them over from an exported HTML bookmarks file.'
            }
            compact={size.h <= 3}
            action={
              <div className={styles.emptyActions}>
                <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ kind: 'add', groupId: addTarget(visibleGroups(allGroups, config)) })}>
                  Add bookmark
                </Button>
                {importHref ? (
                  <a className={styles.emptyLink} href={importHref}>
                    <Import aria-hidden="true" />
                    Import bookmarks
                  </a>
                ) : null}
              </div>
            }
          />
        }
      >
        {(data) =>
          editMode ? (
            <Suspense fallback={<TilesSkeleton />}>
              <EditBoard
                allGroups={data.groups}
                config={config}
                onAdd={(groupId) => setDialog({ kind: 'add', groupId })}
                onEdit={edit}
                onDelete={deleteBookmark}
                onEditGroup={(group) => setDialog({ kind: 'group', group })}
                onDeleteGroup={(group) => setDialog({ kind: 'delete-group', group })}
                onNewGroup={() => setDialog({ kind: 'group', group: null })}
              />
            </Suspense>
          ) : (
            <ViewBoard allGroups={data.groups} config={config} openInNewTab={settings.data?.general.openLinksInNewTab ?? false} onEdit={edit} onDelete={deleteBookmark} />
          )
        }
      </QueryView>

      {/* One boundary each: a dialog loading for the first time must not hide another one. */}
      {mounted.has('bookmark') ? (
        <Suspense fallback={null}>
          <BookmarkDialog
            open={dialog?.kind === 'add' || dialog?.kind === 'edit'}
            onOpenChange={closeDialog}
            groups={allGroups}
            bookmark={dialog?.kind === 'edit' ? dialog.bookmark : null}
            groupId={dialog?.kind === 'add' ? dialog.groupId : null}
            onDelete={(bookmark: Bookmark) => {
              setDialog(null);
              deleteBookmark(bookmark);
            }}
          />
        </Suspense>
      ) : null}
      {mounted.has('group') ? (
        <Suspense fallback={null}>
          <GroupDialog open={dialog?.kind === 'group'} onOpenChange={closeDialog} group={dialog?.kind === 'group' ? dialog.group : null} />
        </Suspense>
      ) : null}
      {mounted.has('delete-group') ? (
        <Suspense fallback={null}>
          <DeleteGroupDialog group={dialog?.kind === 'delete-group' ? dialog.group : null} onOpenChange={closeDialog} />
        </Suspense>
      ) : null}
    </>
  );
}

function TilesSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-label="Loading bookmarks">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={styles.skeletonTile}>
          <Skeleton width={36} height={36} />
          <Skeleton width="70%" height={9} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View board (edit mode: EditBoard.tsx)
// ---------------------------------------------------------------------------

interface ViewBoardProps {
  allGroups: BookmarkGroup[];
  config: LaunchpadConfig;
  openInNewTab: boolean;
  onEdit(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
}

function ViewBoard({ allGroups, config, openInNewTab, onEdit, onDelete }: ViewBoardProps) {
  const move = useMoveBookmark();
  const updateGroup = useUpdateGroup();
  const ungroupedId = useUngroupedId(allGroups);
  const groups = useMemo(() => ungroupedFirst(visibleGroups(allGroups, config), ungroupedId), [allGroups, config, ungroupedId]);
  const showHeaders = groups.length > 1 && config.showGroupHeaders;

  const moveToGroup = (bookmark: Bookmark, groupId: string) => {
    const target = allGroups.find((g) => g.id === groupId);
    if (!target || target.id === bookmark.groupId) return;
    move.mutate({ id: bookmark.id, groupId, index: target.bookmarks.length });
  };

  return (
    <BoardFrame config={config} editMode={false}>
      {groups
        .filter((g) => g.bookmarks.length > 0)
        .map((group) => (
          <GroupShell key={group.id} group={group} showHeader={showHeaders && group.id !== ungroupedId} span={groupSpan(config, group.id)} onToggle={() => updateGroup.mutate({ id: group.id, patch: { collapsed: !group.collapsed } })}>
            {(bodyId) => (
              <ul className={styles.items} id={bodyId} aria-label={showHeaders ? undefined : group.name}>
                {group.bookmarks.map((bookmark) => (
                  <ViewTile
                    key={bookmark.id}
                    bookmark={bookmark}
                    config={config}
                    openInNewTab={openInNewTab}
                    groups={allGroups}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onMove={moveToGroup}
                  />
                ))}
              </ul>
            )}
          </GroupShell>
        ))}
    </BoardFrame>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function BookmarkLink({ bookmark, config, openInNewTab }: { bookmark: Bookmark; config: LaunchpadConfig; openInNewTab: boolean }) {
  const props = linkProps(bookmark.url, { newTab: openInNewTab });
  const showLabel = showsTitle(config);
  if (!props) {
    return (
      <span className={styles.tile} data-disabled="true" title={bookmark.title}>
        <TileBody bookmark={bookmark} config={config} />
      </span>
    );
  }
  return (
    <a {...props} className={styles.tile} title={showLabel ? `${bookmark.title} — ${hostLabel(bookmark.url)}` : bookmark.title} aria-label={showLabel ? undefined : bookmark.title} draggable={false}>
      <TileBody bookmark={bookmark} config={config} />
    </a>
  );
}

interface ViewTileProps {
  bookmark: Bookmark;
  config: LaunchpadConfig;
  openInNewTab: boolean;
  groups: readonly BookmarkGroup[];
  onEdit(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
  onMove(bookmark: Bookmark, groupId: string): void;
}

/**
 * A tile outside edit mode: the link, plus a menu (Edit, Move to, Delete) opened by right-click,
 * a long press, Shift+F10 / the context-menu key, or the "⋯" button shown on hover (UX-6).
 */
function ViewTile({ bookmark, config, openInNewTab, groups, onEdit, onDelete, onMove }: ViewTileProps) {
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const others = groups.filter((g) => g.id !== bookmark.groupId);
  const cancelPress = () => {
    if (press.current.timer !== null) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  useEffect(() => cancelPress, []);
  return (
    <li
      className={styles.item}
      data-bookmark-id={bookmark.id}
      data-menu-open={open ? 'true' : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        setOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          setOpen(true);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch') return;
        press.current.fired = false;
        cancelPress();
        press.current.timer = setTimeout(() => {
          press.current.fired = true;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onClickCapture={(event) => {
        // The finger lifted after a long press: that is not a click on the link.
        if (press.current.fired) {
          event.preventDefault();
          event.stopPropagation();
          press.current.fired = false;
        }
      }}
    >
      <BookmarkLink bookmark={bookmark} config={config} openInNewTab={openInNewTab} />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <IconButton
            icon={Ellipsis}
            size="sm"
            variant="secondary"
            className={styles.tileMenuButton}
            aria-label={`Options for ${bookmark.title}`}
            tooltip={false}
            tabIndex={-1}
          />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil aria-hidden="true" />} onSelect={() => onEdit(bookmark)}>
            Edit…
          </MenuItem>
          {others.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger icon={<FolderInput aria-hidden="true" />}>Move to</MenuSubTrigger>
              <MenuSubContent>
                {others.map((group) => (
                  <MenuItem key={group.id} onSelect={() => onMove(bookmark, group.id)}>
                    {group.name}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          ) : null}
          <MenuSeparator />
          <MenuItem icon={<Trash aria-hidden="true" />} destructive onSelect={() => onDelete(bookmark)}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}
