/**
 * Bookmarks, groups, icons, site meta and imports (§7 Bookmarks).
 *
 * The list (`qk.bookmarks.all()`, matched exactly — the key is also the prefix of import sources
 * and site meta) is updated optimistically by every mutation that the UI can predict (edit,
 * delete, move, collapse, reorder) and rolled back with a toast when the server refuses. After
 * creates and imports the list briefly polls while automatic icons are still being resolved on
 * the server (favicons are fetched in the background so creation stays fast).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Bookmark,
  BookmarkCreate,
  BookmarkGroup,
  BookmarkGroupCreate,
  BookmarkGroupUpdate,
  BookmarkImportReport,
  BookmarkImportSource,
  BookmarksResponse,
  BookmarkUpdate,
  BrowserImport,
  SiteMeta,
} from '@homebase/shared';
import { getCapabilities } from '../capabilities.ts';
import { toastError } from '../ui/toast.ts';
import { apiDelete, apiGet, apiPatch, apiPath, apiPost } from './client.ts';
import { qk } from './keys.ts';
import { UPLOAD_FIELD } from './uploads.ts';

const LIST_KEY = qk.bookmarks.all();
const exact = { queryKey: LIST_KEY, exact: true } as const;

// ---------------------------------------------------------------------------
// Plain requests
// ---------------------------------------------------------------------------

export function fetchBookmarks(signal?: AbortSignal): Promise<BookmarksResponse> {
  return apiGet<BookmarksResponse>('/api/bookmarks', { signal });
}

export function createBookmark(body: BookmarkCreate): Promise<Bookmark> {
  return apiPost<Bookmark>('/api/bookmarks', body);
}

export function updateBookmark(id: string, body: BookmarkUpdate): Promise<Bookmark> {
  return apiPatch<Bookmark>(apiPath`/api/bookmarks/${id}`, body);
}

export function deleteBookmark(id: string): Promise<void> {
  return apiDelete(apiPath`/api/bookmarks/${id}`);
}

export function moveBookmark(id: string, groupId: string, index: number): Promise<BookmarksResponse> {
  return apiPost<BookmarksResponse>(apiPath`/api/bookmarks/${id}/move`, { groupId, index });
}

export function refreshBookmarkIcon(id: string): Promise<Bookmark> {
  return apiPost<Bookmark>(apiPath`/api/bookmarks/${id}/refresh-icon`);
}

export function uploadBookmarkIcon(id: string, file: File): Promise<Bookmark> {
  const form = new FormData();
  form.append(UPLOAD_FIELD, file, file.name);
  return apiPost<Bookmark>(apiPath`/api/bookmarks/${id}/icon`, form);
}

export function createGroup(body: BookmarkGroupCreate): Promise<BookmarkGroup> {
  return apiPost<BookmarkGroup>('/api/bookmark-groups', body);
}

export function updateGroup(id: string, body: BookmarkGroupUpdate): Promise<BookmarkGroup> {
  return apiPatch<BookmarkGroup>(apiPath`/api/bookmark-groups/${id}`, body);
}

export function deleteGroup(id: string): Promise<void> {
  return apiDelete(apiPath`/api/bookmark-groups/${id}`);
}

export function reorderGroups(ids: string[]): Promise<BookmarksResponse> {
  return apiPost<BookmarksResponse>('/api/bookmark-groups/reorder', { ids });
}

export function fetchSiteMeta(url: string, signal?: AbortSignal): Promise<SiteMeta> {
  return apiGet<SiteMeta>(`/api/site-meta?url=${encodeURIComponent(url)}`, { signal });
}

export function fetchImportSources(signal?: AbortSignal): Promise<BookmarkImportSource[]> {
  return apiGet<BookmarkImportSource[]>('/api/bookmarks/import/sources', { signal });
}

export function importFromBrowser(body: BrowserImport): Promise<BookmarkImportReport> {
  return apiPost<BookmarkImportReport>('/api/bookmarks/import/browser', body);
}

export function importFromHtml(file: File, strategy: BrowserImport['targetGroupStrategy']): Promise<BookmarkImportReport> {
  const form = new FormData();
  form.append(UPLOAD_FIELD, file, file.name);
  form.append('targetGroupStrategy', strategy);
  return apiPost<BookmarkImportReport>('/api/bookmarks/import/html', form);
}

// ---------------------------------------------------------------------------
// Pure cache helpers (also used by tests)
// ---------------------------------------------------------------------------

function renumber(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks.map((b, sort) => (b.sort === sort ? b : { ...b, sort }));
}

/** Moves a bookmark to `index` of `groupId` (clamped), renumbering both groups like the server. */
export function moveInGroups(groups: readonly BookmarkGroup[], bookmarkId: string, groupId: string, index: number): BookmarkGroup[] {
  const source = groups.find((g) => g.bookmarks.some((b) => b.id === bookmarkId));
  const moving = source?.bookmarks.find((b) => b.id === bookmarkId);
  if (!source || !moving || !groups.some((g) => g.id === groupId)) return [...groups];
  return groups.map((g) => {
    let list = g.bookmarks.filter((b) => b.id !== bookmarkId);
    if (g.id === groupId) {
      const at = Math.max(0, Math.min(index, list.length));
      list = [...list.slice(0, at), { ...moving, groupId }, ...list.slice(at)];
    } else if (g.id !== source.id) {
      return g;
    }
    return { ...g, bookmarks: renumber(list) };
  });
}

export function patchBookmarkIn(groups: readonly BookmarkGroup[], id: string, patch: Partial<Bookmark>): BookmarkGroup[] {
  return groups.map((g) => (g.bookmarks.some((b) => b.id === id) ? { ...g, bookmarks: g.bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : g));
}

export function removeBookmarkFrom(groups: readonly BookmarkGroup[], id: string): BookmarkGroup[] {
  return groups.map((g) => (g.bookmarks.some((b) => b.id === id) ? { ...g, bookmarks: renumber(g.bookmarks.filter((b) => b.id !== id)) } : g));
}

/** True while some automatic bookmark has no icon yet. */
export function hasPendingIcons(data: BookmarksResponse | undefined): boolean {
  return Boolean(data?.groups.some((g) => g.bookmarks.some((b) => b.iconMode === 'auto' && b.iconId === null)));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

let iconPollUntil = 0;
export const ICON_POLL_WINDOW_MS = 45_000;
export const ICON_POLL_INTERVAL_MS = 3_000;

/**
 * Polls the list for a short while (the server resolves favicons in the background,
 * `iconPolling`). The in-browser backend assigns icons synchronously, so it only refreshes the
 * list once: a bookmark without an icon there (home-network host, automatic icons off) will never
 * get one by waiting.
 */
export function expectNewIcons(client: QueryClient, windowMs = ICON_POLL_WINDOW_MS): void {
  if (getCapabilities().iconPolling) iconPollUntil = Date.now() + windowMs;
  void client.invalidateQueries(exact);
}

export function useBookmarks(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) => fetchBookmarks(signal),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchInterval: (query) => (Date.now() < iconPollUntil && hasPendingIcons(query.state.data) ? ICON_POLL_INTERVAL_MS : false),
  });
}

export function useImportSources(enabled = true) {
  return useQuery({
    queryKey: qk.bookmarks.importSources(),
    queryFn: ({ signal }) => fetchImportSources(signal),
    enabled,
    staleTime: 30_000,
    meta: { persist: false },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

interface Snapshot {
  previous: BookmarksResponse | undefined;
}

async function applyOptimistic(client: QueryClient, update: (groups: BookmarkGroup[]) => BookmarkGroup[]): Promise<Snapshot> {
  await client.cancelQueries(exact);
  const previous = client.getQueryData<BookmarksResponse>(LIST_KEY);
  if (previous) client.setQueryData<BookmarksResponse>(LIST_KEY, { groups: update(previous.groups) });
  return { previous };
}

function rollback(client: QueryClient, snapshot: Snapshot | undefined): void {
  if (snapshot?.previous) client.setQueryData(LIST_KEY, snapshot.previous);
}

function settle(client: QueryClient): Promise<void> {
  return client.invalidateQueries(exact);
}

export function useCreateBookmark() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createBookmark,
    onSuccess: (bookmark) => {
      client.setQueryData<BookmarksResponse>(LIST_KEY, (data) =>
        data
          ? { groups: data.groups.map((g) => (g.id === bookmark.groupId ? { ...g, bookmarks: [...g.bookmarks.filter((b) => b.id !== bookmark.id), bookmark] } : g)) }
          : data,
      );
      if (bookmark.iconMode === 'auto' && bookmark.iconId === null) expectNewIcons(client);
      else void settle(client);
    },
  });
}

export function useUpdateBookmark() {
  const client = useQueryClient();
  return useMutation<Bookmark, Error, { id: string; patch: BookmarkUpdate }, Snapshot>({
    mutationFn: ({ id, patch }) => updateBookmark(id, patch),
    onMutate: ({ id, patch }) =>
      applyOptimistic(client, (groups) => {
        const optimistic: Partial<Bookmark> = {};
        if (patch.title !== undefined) optimistic.title = patch.title;
        if (patch.url !== undefined) optimistic.url = patch.url;
        if (patch.letterColor !== undefined) optimistic.letterColor = patch.letterColor;
        if (patch.iconMode === 'letter') Object.assign(optimistic, { iconMode: 'letter', iconId: null });
        return patchBookmarkIn(groups, id, optimistic);
      }),
    onError: (error, _vars, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The bookmark could not be saved.');
    },
    onSuccess: (bookmark) => {
      client.setQueryData<BookmarksResponse>(LIST_KEY, (data) => (data ? { groups: patchBookmarkIn(data.groups, bookmark.id, bookmark) } : data));
      if (bookmark.iconMode === 'auto' && bookmark.iconId === null) expectNewIcons(client);
    },
    onSettled: () => settle(client),
  });
}

export function useDeleteBookmark() {
  const client = useQueryClient();
  return useMutation<void, Error, Bookmark, Snapshot>({
    mutationFn: (bookmark) => deleteBookmark(bookmark.id),
    onMutate: (bookmark) => applyOptimistic(client, (groups) => removeBookmarkFrom(groups, bookmark.id)),
    onError: (error, _bookmark, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The bookmark could not be deleted.');
    },
    onSettled: () => settle(client),
  });
}

/**
 * Re-creates a deleted bookmark at its old position (Undo). The icon is passed back by id: custom
 * icons are kept on the server for an undo window.
 */
export async function restoreBookmark(client: QueryClient, bookmark: Bookmark): Promise<void> {
  const created = await createBookmark({
    groupId: bookmark.groupId,
    title: bookmark.title,
    url: bookmark.url,
    iconMode: bookmark.iconMode,
    iconId: bookmark.iconId,
    letterColor: bookmark.letterColor,
  });
  const moved = await moveBookmark(created.id, bookmark.groupId, bookmark.sort);
  client.setQueryData<BookmarksResponse>(LIST_KEY, moved);
}

export interface MoveVars {
  id: string;
  groupId: string;
  index: number;
}

export function useMoveBookmark() {
  const client = useQueryClient();
  return useMutation<BookmarksResponse, Error, MoveVars, Snapshot>({
    mutationFn: ({ id, groupId, index }) => moveBookmark(id, groupId, index),
    onMutate: ({ id, groupId, index }) => applyOptimistic(client, (groups) => moveInGroups(groups, id, groupId, index)),
    onError: (error, _vars, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The bookmark could not be moved.');
    },
    onSuccess: (data) => client.setQueryData(LIST_KEY, data),
  });
}

export function useRefreshBookmarkIcon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: refreshBookmarkIcon,
    onSuccess: (bookmark) => {
      client.setQueryData<BookmarksResponse>(LIST_KEY, (data) => (data ? { groups: patchBookmarkIn(data.groups, bookmark.id, bookmark) } : data));
      void settle(client);
    },
    onError: (error) => toastError(error, 'The icon could not be refreshed.'),
  });
}

export function useUploadBookmarkIcon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => uploadBookmarkIcon(id, file),
    onSuccess: (bookmark) => {
      client.setQueryData<BookmarksResponse>(LIST_KEY, (data) => (data ? { groups: patchBookmarkIn(data.groups, bookmark.id, bookmark) } : data));
    },
  });
}

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createGroup,
    onSuccess: (group) => {
      client.setQueryData<BookmarksResponse>(LIST_KEY, (data) => (data ? { groups: [...data.groups.filter((g) => g.id !== group.id), group] } : data));
      void settle(client);
    },
  });
}

export function useUpdateGroup() {
  const client = useQueryClient();
  return useMutation<BookmarkGroup, Error, { id: string; patch: BookmarkGroupUpdate }, Snapshot>({
    mutationFn: ({ id, patch }) => updateGroup(id, patch),
    onMutate: ({ id, patch }) =>
      applyOptimistic(client, (groups) =>
        groups.map((g) => {
          if (g.id !== id) return g;
          const next = { ...g };
          if (patch.name !== undefined) next.name = patch.name;
          if (patch.color !== undefined) next.color = patch.color;
          if (patch.collapsed !== undefined) next.collapsed = patch.collapsed;
          return next;
        }),
      ),
    onError: (error, _vars, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The group could not be saved.');
    },
    onSettled: () => settle(client),
  });
}

export function useDeleteGroup() {
  const client = useQueryClient();
  return useMutation<void, Error, string, Snapshot>({
    mutationFn: deleteGroup,
    onMutate: (id) => applyOptimistic(client, (groups) => groups.filter((g) => g.id !== id)),
    onError: (error, _id, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The group could not be deleted.');
    },
    onSettled: () => Promise.all([settle(client), client.invalidateQueries({ queryKey: qk.settings() })]).then(() => undefined),
  });
}

export function useReorderGroups() {
  const client = useQueryClient();
  return useMutation<BookmarksResponse, Error, string[], Snapshot>({
    mutationFn: reorderGroups,
    onMutate: (ids) =>
      applyOptimistic(client, (groups) => {
        const byId = new Map(groups.map((g) => [g.id, g]));
        const ordered = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
        const rest = groups.filter((g) => !ids.includes(g.id));
        return [...ordered, ...rest].map((g, sort) => ({ ...g, sort }));
      }),
    onError: (error, _ids, snapshot) => {
      rollback(client, snapshot);
      toastError(error, 'The groups could not be reordered.');
    },
    onSuccess: (data) => client.setQueryData(LIST_KEY, data),
  });
}

export function useImportFromBrowser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: importFromBrowser,
    onSuccess: () => expectNewIcons(client),
  });
}

export function useImportFromHtml() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ file, strategy }: { file: File; strategy: BrowserImport['targetGroupStrategy'] }) => importFromHtml(file, strategy),
    onSuccess: () => expectNewIcons(client),
  });
}
