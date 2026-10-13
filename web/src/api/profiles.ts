/**
 * Profiles and their widget layouts (§7 Core, §10.2). Layout edits never overwrite a whole
 * layout: positions go through `PUT /positions`, widget config/frame through
 * `PATCH /widgets/:instanceId`, adds/removes through their own routes. Every mutation updates the
 * cached profile list optimistically and re-syncs with the server afterwards.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ProfileSchema,
  type Layout,
  type Profile,
  type ProfileCreate,
  type ProfileUpdate,
  type Settings,
  type WidgetCreate,
  type WidgetInstance,
  type WidgetPosition,
  type WidgetUpdate,
} from '@homebase/shared';
import { toastError } from '../ui/toast.ts';
import { apiDelete, apiGet, apiPatch, apiPath, apiPost, apiPut } from './client.ts';
import { qk } from './keys.ts';

export function fetchProfiles(signal?: AbortSignal): Promise<Profile[]> {
  return apiGet<Profile[]>('/api/profiles', { signal });
}

export function useProfiles() {
  return useQuery({
    queryKey: qk.profiles(),
    queryFn: ({ signal }) => fetchProfiles(signal),
    staleTime: 60_000,
  });
}

/** The active profile: `settings.activeProfileId` if it exists, else the first profile, else null. */
export function pickActiveProfile(profiles: readonly Profile[], activeProfileId: string | null): Profile | null {
  return profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null;
}

/** Profiles in display order. */
export function sortProfiles(profiles: readonly Profile[]): Profile[] {
  return [...profiles].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Plain requests
// ---------------------------------------------------------------------------

/** `POST /api/profiles` → the created profile (null if the response is not a profile). */
export async function createProfile(body: ProfileCreate): Promise<Profile | null> {
  const created = await apiPost<unknown>('/api/profiles', body);
  const parsed = ProfileSchema.safeParse(created);
  return parsed.success ? parsed.data : null;
}

export function updateProfile(profileId: string, body: ProfileUpdate): Promise<unknown> {
  return apiPatch<unknown>(apiPath`/api/profiles/${profileId}`, body);
}

export function deleteProfile(profileId: string): Promise<void> {
  return apiDelete(apiPath`/api/profiles/${profileId}`);
}

export function activateProfile(profileId: string): Promise<unknown> {
  return apiPost<unknown>(apiPath`/api/profiles/${profileId}/activate`);
}

export function savePositions(profileId: string, items: WidgetPosition[]): Promise<unknown> {
  return apiPut<unknown>(apiPath`/api/profiles/${profileId}/positions`, { items });
}

export function addWidget(profileId: string, body: WidgetCreate): Promise<unknown> {
  return apiPost<unknown>(apiPath`/api/profiles/${profileId}/widgets`, body);
}

export function updateWidget(profileId: string, instanceId: string, body: WidgetUpdate): Promise<unknown> {
  return apiPatch<unknown>(apiPath`/api/profiles/${profileId}/widgets/${instanceId}`, body);
}

export function removeWidget(profileId: string, instanceId: string): Promise<void> {
  return apiDelete(apiPath`/api/profiles/${profileId}/widgets/${instanceId}`);
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Rewrites one profile's layout in the cache. Returns the previous list for rollback. */
export function updateCachedLayout(
  client: QueryClient,
  profileId: string,
  update: (layout: Layout) => Layout,
): Profile[] | undefined {
  const previous = client.getQueryData<Profile[]>(qk.profiles());
  if (!previous) return previous;
  client.setQueryData<Profile[]>(
    qk.profiles(),
    previous.map((p) => (p.id === profileId ? { ...p, layout: update(p.layout) } : p)),
  );
  return previous;
}

/** The cached widget instance (latest optimistic state). */
export function getCachedWidget(client: QueryClient, profileId: string, instanceId: string): WidgetInstance | undefined {
  return client
    .getQueryData<Profile[]>(qk.profiles())
    ?.find((p) => p.id === profileId)
    ?.layout.items.find((i) => i.id === instanceId);
}

/** Applies positions to a layout (unknown ids are ignored). */
export function applyPositions(layout: Layout, positions: readonly WidgetPosition[]): Layout {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return {
    ...layout,
    items: layout.items.map((item) => {
      const pos = byId.get(item.id);
      return pos ? { ...item, x: pos.x, y: pos.y, w: pos.w, h: pos.h } : item;
    }),
  };
}

function invalidateProfiles(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.profiles() });
}

// ---------------------------------------------------------------------------
// Profile mutations
// ---------------------------------------------------------------------------

export function useCreateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createProfile,
    onError: (error) => toastError(error, 'The profile could not be created.'),
    onSettled: () => invalidateProfiles(client),
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ProfileUpdate & { id: string }) => updateProfile(id, body),
    onMutate: async ({ id, ...body }) => {
      await client.cancelQueries({ queryKey: qk.profiles() });
      const previous = client.getQueryData<Profile[]>(qk.profiles());
      if (previous) client.setQueryData<Profile[]>(qk.profiles(), previous.map((p) => (p.id === id ? { ...p, ...body } : p)));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(qk.profiles(), context.previous);
      toastError(error, 'The profile could not be updated.');
    },
    onSettled: () => invalidateProfiles(client),
  });
}

/** Swaps two profiles' sort values (move up/down) with one PATCH each. */
export function useReorderProfiles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (ordered: Profile[]) => {
      const changes = ordered.map((p, index) => ({ id: p.id, sort: index })).filter((c, i) => ordered[i]!.sort !== c.sort);
      for (const change of changes) await updateProfile(change.id, { sort: change.sort });
    },
    onMutate: async (ordered) => {
      await client.cancelQueries({ queryKey: qk.profiles() });
      const previous = client.getQueryData<Profile[]>(qk.profiles());
      client.setQueryData<Profile[]>(
        qk.profiles(),
        ordered.map((p, index) => ({ ...p, sort: index })),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) client.setQueryData(qk.profiles(), context.previous);
      toastError(error, 'The profiles could not be reordered.');
    },
    onSettled: () => invalidateProfiles(client),
  });
}

export function useDeleteProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteProfile,
    onError: (error) => toastError(error, 'The profile could not be deleted.'),
    onSettled: async () => {
      await Promise.all([invalidateProfiles(client), client.invalidateQueries({ queryKey: qk.settings() })]);
    },
  });
}

/** Switches the active profile (`settings.activeProfileId`), optimistically. */
export function useActivateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: activateProfile,
    onMutate: async (profileId) => {
      await client.cancelQueries({ queryKey: qk.settings() });
      const previous = client.getQueryData<Settings>(qk.settings());
      if (previous) client.setQueryData<Settings>(qk.settings(), { ...previous, activeProfileId: profileId });
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) client.setQueryData(qk.settings(), context.previous);
      toastError(error, 'Could not switch profiles.');
    },
    onSettled: () => client.invalidateQueries({ queryKey: qk.settings() }),
  });
}

// ---------------------------------------------------------------------------
// Widget mutations
// ---------------------------------------------------------------------------

export function useAddWidget(profileId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: WidgetCreate) => {
      if (profileId === null) throw new Error('No profile to add the widget to');
      return addWidget(profileId, body);
    },
    onError: (error) => toastError(error, 'The widget could not be added.'),
    onSettled: () => invalidateProfiles(client),
  });
}

export function useRemoveWidget(profileId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => {
      if (profileId === null) throw new Error('No profile');
      return removeWidget(profileId, instanceId);
    },
    onMutate: async (instanceId) => {
      if (profileId === null) return { previous: undefined };
      await client.cancelQueries({ queryKey: qk.profiles() });
      const previous = updateCachedLayout(client, profileId, (layout) => ({
        ...layout,
        items: layout.items.filter((i) => i.id !== instanceId),
      }));
      return { previous };
    },
    onError: (error, _id, context) => {
      if (context?.previous) client.setQueryData(qk.profiles(), context.previous);
      toastError(error, 'The widget could not be removed.');
    },
    onSettled: () => invalidateProfiles(client),
  });
}

/** Merges a frame patch the way the server does (`title: null` clears the custom title). */
export function mergeFrame(frame: WidgetInstance['frame'], patch: WidgetUpdate['frame']): WidgetInstance['frame'] {
  if (!patch) return frame;
  const next = { ...frame };
  if (patch.showHeader !== undefined) next.showHeader = patch.showHeader;
  if (patch.transparent !== undefined) next.transparent = patch.transparent;
  if (patch.title === null || patch.title === '') delete next.title;
  else if (patch.title !== undefined) next.title = patch.title;
  return next;
}

/**
 * `PATCH /widgets/:instanceId {config?, frame?}`: config replaces, frame merges. Optimistic; the
 * cache is rolled back and a toast shown if the server refuses.
 */
export async function saveWidget(
  client: QueryClient,
  profileId: string,
  instanceId: string,
  body: WidgetUpdate,
): Promise<void> {
  await client.cancelQueries({ queryKey: qk.profiles() });
  const previous = updateCachedLayout(client, profileId, (layout) => ({
    ...layout,
    items: layout.items.map((item) =>
      item.id === instanceId
        ? { ...item, ...(body.config !== undefined ? { config: body.config } : {}), frame: mergeFrame(item.frame, body.frame) }
        : item,
    ),
  }));
  try {
    await updateWidget(profileId, instanceId, body);
  } catch (error) {
    if (previous) client.setQueryData(qk.profiles(), previous);
    toastError(error, 'The widget settings could not be saved.');
    throw error;
  } finally {
    void invalidateProfiles(client);
  }
}
