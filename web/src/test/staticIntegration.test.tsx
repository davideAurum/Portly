/**
 * End-to-end user flows of the browser-only build against the REAL static backend
 * (`src/static/backend.ts` with every handler module wired, over an in-memory storage):
 * first-run seeding, settings autosave, the launch pad's add/delete/undo, profile management,
 * an export → import round trip, and the server-only notices. Every test runs as the Pages build
 * on its in-browser backend (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`), so the
 * gating (default layout, hidden sections, asset URLs) is on; the widget registry keeps its
 * definitions but renders stand-ins, as the shell tests do, so the dashboard flows stay about the
 * shell ↔ backend contract (the launch pad is rendered for real).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExportSchema,
  defaultSettings,
  newId,
  type BookmarkGroup,
  type BookmarksResponse,
  type ExportFile,
  type Profile,
  type Settings,
} from '@portly/shared';
import { apiGet, apiPost } from '../api/client.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { commitImport, previewImport } from '../api/importExport.ts';
import { Shell } from '../app/Shell.tsx';
import { Dashboard } from '../grid/Dashboard.tsx';
import { createDefaultLayout } from '../grid/defaultLayout.ts';
import GeneralSettings from '../settings/sections/General.tsx';
import ProfilesSettings from '../settings/sections/Profiles.tsx';
import { SLICE, getBackups, getBookmarks, getProfiles, getSettings, type StoredProfile } from '../static/slices.ts';
import { MemoryStorage } from '../static/storage/memory.ts';
import { launchpadConfigSchema } from '../widgets/launchpad/index.ts';
import LaunchpadWidget from '../widgets/launchpad/Widget.tsx';
import { widget } from './fixtures.ts';
import { renderWithStaticBackend, stubFetchWithStaticBackend } from './renderWithStaticBackend.tsx';
import { stubWidgetText } from './stubWidgets.tsx';

vi.mock('../widgets/registry.ts', async (importOriginal) => {
  const { stubWidgetRegistry } = await import('./stubWidgets.tsx');
  return stubWidgetRegistry(await importOriginal());
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATIC_DEFAULT_TYPES = ['search', 'clock', 'launchpad', 'weather', 'todoist'];
const DDG_GITHUB_ICON = 'https://icons.duckduckgo.com/ip3/github.com.ico';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

function renderLaunchpad() {
  return renderWithStaticBackend(
    <LaunchpadWidget instanceId="lp" config={launchpadConfigSchema.parse({})} setConfig={async () => {}} size={{ w: 8, h: 6 }} editMode={false} />,
  );
}

// ---------------------------------------------------------------------------
// 1. First run
// ---------------------------------------------------------------------------

describe('static build: first run', () => {
  it('seeds and activates a "Home" profile with the static default widgets, once per storage', async () => {
    const storage = new MemoryStorage();
    const first = await renderWithStaticBackend(<Dashboard />, { storage });

    await waitFor(() => expect(first.requestsTo('POST /api/profiles')).toHaveLength(1));
    expect(first.requestsTo('POST /api/profiles')[0]!.status).toBe(201);
    // The dashboard shows the seeded profile's widgets (stand-ins), not the read-only default layout.
    await waitFor(() => expect(screen.getAllByText(/^Stub widget: /)).toHaveLength(STATIC_DEFAULT_TYPES.length));
    for (const type of STATIC_DEFAULT_TYPES) expect(screen.getByText(stubWidgetText(type))).toBeInTheDocument();
    expect(screen.queryByText(stubWidgetText('calendar'))).not.toBeInTheDocument();
    expect(screen.queryByText(stubWidgetText('mail'))).not.toBeInTheDocument();

    const rows = getProfiles(first.ctx);
    expect(rows).toHaveLength(1);
    const home = rows[0]!;
    expect(home.name).toBe('Home');
    expect(home.id).toMatch(UUID);
    expect(home.layout.items.map((i) => i.type)).toEqual(STATIC_DEFAULT_TYPES);
    // Positions and frames come from the static default layout; ids are fresh UUIDs, never the placeholders.
    const defaults = createDefaultLayout().items;
    for (const item of home.layout.items) {
      expect(item.id).toMatch(UUID);
      const def = defaults.find((d) => d.type === item.type)!;
      expect({ x: item.x, y: item.y, w: item.w, h: item.h, frame: item.frame }).toEqual({ x: def.x, y: def.y, w: def.w, h: def.h, frame: def.frame });
    }

    // Activated through POST /activate and persisted (settings slice) …
    await waitFor(() => expect(first.requestsTo(`POST /api/profiles/${home.id}/activate`)).toHaveLength(1));
    await waitFor(() => expect(getSettings(first.ctx).activeProfileId).toBe(home.id));
    // … plus the browser-locale defaults (jsdom reports en-US) through PATCH /api/settings.
    await waitFor(() => expect(first.requestsTo('PATCH /api/settings')).toHaveLength(1));
    await waitFor(() => expect(getSettings(first.ctx).general).toMatchObject({ weekStartsOn: 0, temperatureUnit: 'F', windUnit: 'mph', precipUnit: 'in' }));
    expect(await storage.getJson('slice:profiles')).toEqual(rows);
    expect(((await storage.getJson('slice:settings')) as Settings).activeProfileId).toBe(home.id);

    // A second page load over the same storage (new backend, new QueryClient) finds the profile and does not seed again.
    cleanup();
    first.close();
    const second = await renderWithStaticBackend(<Dashboard />, { storage });
    await waitFor(() => expect(screen.getAllByText(/^Stub widget: /)).toHaveLength(STATIC_DEFAULT_TYPES.length));
    await settle();
    expect(second.requestsTo('POST /api/profiles')).toHaveLength(0);
    expect(second.requestsTo('GET /api/profiles').length).toBeGreaterThanOrEqual(1);
    expect(getProfiles(second.ctx).map((p) => p.id)).toEqual([home.id]);
    expect(getSettings(second.ctx).activeProfileId).toBe(home.id);
    expect(await second.backend.fetch('/api/profiles').then((r) => r.json())).toEqual([{ id: home.id, name: 'Home', sort: 0, layout: home.layout }]);
  });
});

// ---------------------------------------------------------------------------
// 2. Settings autosave
// ---------------------------------------------------------------------------

describe('static build: settings autosave', () => {
  it('persists a General setting through PATCH /api/settings and survives a fresh backend over the same storage', async () => {
    const storage = new MemoryStorage();
    const { ctx, close, requestsTo } = await renderWithStaticBackend(<GeneralSettings />, { storage });
    const user = userEvent.setup();
    await screen.findByRole('form', { name: 'General settings' });
    expect(requestsTo('GET /api/settings')).toHaveLength(1);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Language and region' }), 'de-DE');
    await user.click(screen.getByRole('radio', { name: '24-hour' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings').length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(getSettings(ctx).general).toMatchObject({ locale: 'de-DE', timeFormat: '24h' }));
    expect(requestsTo('PATCH /api/settings').every((r) => r.status === 200)).toBe(true);
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();

    // Text fields save when they lose focus.
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), '  Dana  ');
    await user.tab();
    await waitFor(() => expect(getSettings(ctx).general.userName).toBe('Dana'));
    // The whole settings object stays valid and the untouched namespaces keep their defaults.
    expect(getSettings(ctx).appearance).toEqual(defaultSettings().appearance);
    expect(((await storage.getJson('slice:settings')) as Settings).general).toMatchObject({ locale: 'de-DE', timeFormat: '24h', userName: 'Dana' });

    // A fresh backend over the same storage (a reload) answers with the saved values.
    cleanup();
    close();
    const fresh = await stubFetchWithStaticBackend({ storage });
    const reloaded = await apiGet<Settings>('/api/settings');
    expect(reloaded.general).toMatchObject({ locale: 'de-DE', timeFormat: '24h', userName: 'Dana' });
    expect(fresh.requests).toEqual([{ method: 'GET', path: '/api/settings', search: '', status: 200 }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Launch pad: add, delete, undo
// ---------------------------------------------------------------------------

describe('static build: launch pad', () => {
  it('adds a bookmark from the dialog with the synthetic favicon id, shown through the DuckDuckGo icon URL', async () => {
    const { ctx, requestsTo } = await renderLaunchpad();
    const user = userEvent.setup();

    expect(await screen.findByText('No bookmarks yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add bookmark' });
    await user.type(within(dialog).getByRole('textbox', { name: /Address/ }), 'github.com');
    // The static site-meta route derives the title from the host and answers the synthetic icon id.
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Github'));
    expect(requestsTo('GET /api/site-meta')).toEqual([{ method: 'GET', path: '/api/site-meta', search: `?url=${encodeURIComponent('https://github.com/')}`, status: 200 }]);
    expect(within(dialog).getByText('Filled in from the address.')).toBeInTheDocument();
    // No group exists yet: the bookmark goes under "No group" (that group is created on save).
    expect(within(dialog).getByRole('combobox', { name: 'Group' })).toHaveValue('__none__');

    await user.click(within(dialog).getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add bookmark' })).not.toBeInTheDocument());
    expect(requestsTo('POST /api/bookmark-groups')).toEqual([{ method: 'POST', path: '/api/bookmark-groups', search: '', status: 201 }]);
    expect(requestsTo('POST /api/bookmarks')).toEqual([{ method: 'POST', path: '/api/bookmarks', search: '', status: 201 }]);
    expect(await screen.findByText('Added “Github”')).toBeInTheDocument();

    // Backend state: the "No group" group (recorded in settings) with the bookmark, icon id fav:github.com.
    const slice = getBookmarks(ctx);
    expect(slice.groups.map((g) => g.name)).toEqual(['No group']);
    expect(slice.bookmarks).toHaveLength(1);
    expect(slice.bookmarks[0]).toMatchObject({
      groupId: slice.groups[0]!.id,
      title: 'Github',
      url: 'https://github.com/',
      sort: 0,
      iconMode: 'auto',
      iconId: 'fav:github.com',
      letterColor: null,
    });
    expect(slice.bookmarks[0]!.id).toMatch(UUID);

    // The tile: a link to the site whose icon <img> resolves to DuckDuckGo's icon service.
    const link = await screen.findByRole('link', { name: 'Github' });
    expect(link).toHaveAttribute('href', 'https://github.com/');
    const img = link.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', DDG_GITHUB_ICON);
    // The API shape the UI consumed carries the synthetic id, not a service URL.
    const listed = (await apiGet<BookmarksResponse>('/api/bookmarks')).groups[0]!;
    expect(listed.bookmarks[0]).toMatchObject({ title: 'Github', iconMode: 'auto', iconId: 'fav:github.com' });
  });

  it('deletes a bookmark from the tile menu and Undo re-creates it with a new id at its old position', async () => {
    const { ctx, requestsTo } = await renderWithStaticBackend(
      <LaunchpadWidget instanceId="lp" config={launchpadConfigSchema.parse({})} setConfig={async () => {}} size={{ w: 8, h: 6 }} editMode={false} />,
      {
        seed: async (c) => {
          const ts = c.now();
          const store = getBookmarks(c);
          store.groups.push({ id: 'g1', name: 'Work', sort: 0, color: null, collapsed: false, createdAt: ts, updatedAt: ts, placedAt: ts });
          store.bookmarks.push(
            { id: 'b1', groupId: 'g1', title: 'Github', url: 'https://github.com/', sort: 0, iconMode: 'auto', iconId: 'fav:github.com', letterColor: null, createdAt: ts, updatedAt: ts, placedAt: ts },
            { id: 'b2', groupId: 'g1', title: 'Nas', url: 'http://nas/', sort: 1, iconMode: 'auto', iconId: null, letterColor: null, createdAt: ts, updatedAt: ts, placedAt: ts },
          );
          await c.state.commit(SLICE.bookmarks);
        },
      },
    );
    const user = userEvent.setup();

    const link = await screen.findByRole('link', { name: 'Github' });
    expect(link.querySelector('img')).toHaveAttribute('src', DDG_GITHUB_ICON);
    // A home-network host never gets an icon: letter tile, no <img>.
    expect(screen.getByRole('link', { name: 'Nas' }).querySelector('img')).toBeNull();

    await user.pointer({ keys: '[MouseRight]', target: link });
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Delete/ }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmarks/b1')).toEqual([{ method: 'DELETE', path: '/api/bookmarks/b1', search: '', status: 204 }]));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Github' })).not.toBeInTheDocument());
    expect(getBookmarks(ctx).bookmarks.map((b) => [b.id, b.sort])).toEqual([['b2', 0]]);

    const toastText = await screen.findByText('Deleted “Github”');
    fireEvent.click(within(toastText.closest('li') ?? document.body).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.status).toBe(201);
    const restored = await screen.findByRole('link', { name: 'Github' });
    expect(restored.querySelector('img')).toHaveAttribute('src', DDG_GITHUB_ICON);

    // Re-created at its old position (POST + move), under a fresh id, with the favicon id kept.
    await waitFor(() => expect(getBookmarks(ctx).bookmarks).toHaveLength(2));
    const rows = [...getBookmarks(ctx).bookmarks].sort((a, b) => a.sort - b.sort);
    expect(rows.map((b) => [b.title, b.sort])).toEqual([
      ['Github', 0],
      ['Nas', 1],
    ]);
    expect(rows[0]).toMatchObject({ groupId: 'g1', url: 'https://github.com/', iconMode: 'auto', iconId: 'fav:github.com' });
    expect(rows[0]!.id).not.toBe('b1');
    expect(rows[0]!.id).toMatch(UUID);
    expect(requestsTo(`POST /api/bookmarks/${rows[0]!.id}/move`)).toEqual([{ method: 'POST', path: `/api/bookmarks/${rows[0]!.id}/move`, search: '', status: 200 }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Profiles
// ---------------------------------------------------------------------------

describe('static build: profiles', () => {
  it('creates, renames, activates and deletes profiles through Settings → Profiles', async () => {
    const { ctx, requestsTo } = await renderWithStaticBackend(<ProfilesSettings />);
    const user = userEvent.setup();

    expect(await screen.findByText('No profiles yet')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Create a profile' });

    // The first profile from the default layout: activates itself (nothing was active).
    await user.type(within(form).getByLabelText(/^Name/), 'Home');
    expect(within(form).getByLabelText('Start from')).toHaveValue('default');
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Home created.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Profiles' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText('Active')).toBeInTheDocument();
    expect(within(list).getByText(`${STATIC_DEFAULT_TYPES.length} widgets`)).toBeInTheDocument();
    const homeId = getProfiles(ctx)[0]!.id;
    expect(homeId).toMatch(UUID);
    expect(getProfiles(ctx)[0]!.layout.items.map((i) => i.type)).toEqual(STATIC_DEFAULT_TYPES);
    expect(getSettings(ctx).activeProfileId).toBe(homeId);

    // A second, empty profile.
    await user.type(within(form).getByLabelText(/^Name/), 'Work');
    await user.selectOptions(within(form).getByLabelText('Start from'), 'An empty dashboard');
    await user.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Work created.')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('Work');
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('0 widgets');
    expect(within(list).getByRole('button', { name: 'Make active' })).toBeInTheDocument();
    const workId = getProfiles(ctx).find((p) => p.name === 'Work')!.id;
    expect(getProfiles(ctx).find((p) => p.id === workId)).toMatchObject({ sort: 1, layout: { version: 1, items: [] } });
    expect(getSettings(ctx).activeProfileId).toBe(homeId);

    // Rename.
    await user.click(within(list).getByRole('button', { name: 'Rename Work' }));
    const input = within(list).getByRole('textbox', { name: 'Profile name' });
    await user.clear(input);
    await user.type(input, 'Office{Enter}');
    await waitFor(() => expect(requestsTo(`PATCH /api/profiles/${workId}`)).toHaveLength(1));
    expect(requestsTo(`PATCH /api/profiles/${workId}`)[0]!.status).toBe(200);
    expect(await within(list).findByRole('button', { name: 'Rename Office' })).toBeInTheDocument();
    await waitFor(() => expect(getProfiles(ctx).find((p) => p.id === workId)!.name).toBe('Office'));

    // Activate.
    await user.click(within(list).getByRole('button', { name: 'Make active' }));
    await waitFor(() => expect(requestsTo(`POST /api/profiles/${workId}/activate`)).toHaveLength(1));
    await waitFor(() => expect(getSettings(ctx).activeProfileId).toBe(workId));
    await waitFor(() => expect(within(within(list).getAllByRole('listitem')[1]!).getByText('Active')).toBeInTheDocument());

    // Delete the active one: the backend re-points the active profile to the first remaining.
    await user.click(within(list).getByRole('button', { name: 'Delete Office' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Office?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(requestsTo(`DELETE /api/profiles/${workId}`)).toEqual([{ method: 'DELETE', path: `/api/profiles/${workId}`, search: '', status: 204 }]));
    expect(await screen.findByText('Office deleted.')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(getProfiles(ctx).map((p) => [p.id, p.name])).toEqual([[homeId, 'Home']]);
    expect(getSettings(ctx).activeProfileId).toBe(homeId);
    await waitFor(() => expect(within(list).getByText('Active')).toBeInTheDocument());
    // The last profile cannot be deleted.
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Delete Home' })).toBeDisabled());
    expect(await ctx.state.storage.getJson('slice:profiles')).toEqual(getProfiles(ctx));
  });
});

// ---------------------------------------------------------------------------
// 5. Export → import round trip
// ---------------------------------------------------------------------------

describe('static build: export and import', () => {
  it('round-trips through GET /api/export, POST /api/import/preview and /commit, giving everything new ids', async () => {
    const { ctx, requests } = await stubFetchWithStaticBackend();

    const group = await apiPost<BookmarkGroup>('/api/bookmark-groups', { name: 'Work', color: '#112233' });
    const bookmark = await apiPost<{ id: string; iconId: string | null }>('/api/bookmarks', { groupId: group.id, title: 'Github', url: 'https://github.com/' });
    expect(bookmark.iconId).toBe('fav:github.com');
    const profile = await apiPost<Profile>('/api/profiles', { name: 'Home', layout: createDefaultLayout(() => newId()) });
    const settings = await apiGet<Settings>('/api/settings');
    expect(settings.activeProfileId).toBe(profile.id);
    const widgetIds = profile.layout.items.map((i) => i.id);

    // Export, as the Import & export page downloads it (api() parses the JSON body).
    const file = await apiGet<ExportFile>('/api/export');
    expect(ExportSchema.safeParse(file).success).toBe(true);
    expect(file.data.profiles.map((p) => p.id)).toEqual([profile.id]);
    expect(file.data.bookmarkGroups).toEqual([{ id: group.id, name: 'Work', sort: 0, color: '#112233', collapsed: false }]);
    // Synthetic favicon ids never travel on bookmarks.
    expect(file.data.bookmarks).toEqual([{ id: bookmark.id, groupId: group.id, title: 'Github', url: 'https://github.com/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null }]);
    expect(file.data.settings.activeProfileId).toBe(profile.id);

    // Import it back through the page's own request helpers: a File in a FormData, which the
    // fetch stub serializes as multipart bytes (vitest's jsdom shim cannot hand a jsdom FormData
    // to Node's Request, see renderWithStaticBackend.tsx) and the backend parses with req.formData().
    const upload = new File([JSON.stringify(file)], 'portly-export.json', { type: 'application/json' });
    const preview = await previewImport(upload);
    expect(preview.previewId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(preview.summary.counts).toEqual({ profiles: 1, widgets: STATIC_DEFAULT_TYPES.length, bookmarkGroups: 1, bookmarks: 1, uploads: 0, customIcons: 0 });
    expect(preview.summary.dropped).toEqual({ unknownWidgets: 0, notes: [] });
    expect(preview.summary.exportedAt).toBe(file.exportedAt);
    // Nothing changes until the commit.
    expect(getProfiles(ctx).map((p) => p.id)).toEqual([profile.id]);

    const committed = await commitImport(preview.previewId);
    expect(committed).toEqual({ ok: true, summary: preview.summary });
    expect(requests.filter((r) => r.path.startsWith('/api/import/')).map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual([
      'POST /api/import/preview 200',
      'POST /api/import/commit 200',
    ]);

    // Everything was replaced with fresh ids and remapped references; the bookmark survives.
    const profilesAfter = getProfiles(ctx);
    expect(profilesAfter).toHaveLength(1);
    const imported = profilesAfter[0]!;
    expect(imported.id).not.toBe(profile.id);
    expect(imported.name).toBe('Home');
    expect(imported.layout.items.map((i) => i.type)).toEqual(STATIC_DEFAULT_TYPES);
    for (const item of imported.layout.items) expect(widgetIds).not.toContain(item.id);
    expect(getSettings(ctx).activeProfileId).toBe(imported.id);

    const store = getBookmarks(ctx);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0]!.id).not.toBe(group.id);
    expect(store.groups[0]).toMatchObject({ name: 'Work', color: '#112233', sort: 0 });
    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]!.id).not.toBe(bookmark.id);
    // The automatic icon comes back as the host's synthetic id (autoFetchIcons is on by default).
    expect(store.bookmarks[0]).toMatchObject({ groupId: store.groups[0]!.id, title: 'Github', url: 'https://github.com/', iconMode: 'auto', iconId: 'fav:github.com' });
    const listed = await apiGet<BookmarksResponse>('/api/bookmarks');
    expect(listed.groups[0]!.bookmarks[0]).toMatchObject({ id: store.bookmarks[0]!.id, title: 'Github', iconId: 'fav:github.com' });

    // A pre-import backup of the previous export was kept (downloadable), and the preview is spent.
    expect(getBackups(ctx).entries).toHaveLength(1);
    const backups = await apiGet<{ id: string; at: string; bytes: number }[]>('/api/backups');
    expect(backups.map((b) => b.id)).toEqual([getBackups(ctx).entries[0]!.id]);
    expect(await apiGet<unknown>(`/api/backups/${backups[0]!.id}`)).toEqual(file);
    await expect(commitImport(preview.previewId)).rejects.toMatchObject({ name: 'ApiError', code: 'not_found', status: 404 });
  });
});

// ---------------------------------------------------------------------------
// 6. Server-only features
// ---------------------------------------------------------------------------

describe('static build: server-only features', () => {
  it('opens Calendars for Outlook.com alone: no ICS subscriptions, no server notice', async () => {
    const { requestsTo } = await renderWithStaticBackend(<Shell />, { route: '#/settings/calendars' });
    expect(await screen.findByText('No calendar accounts')).toBeInTheDocument();
    expect(screen.getByText('Connect Outlook.com to see its calendars here.')).toBeInTheDocument();
    expect(screen.getByText(/Outlook\.com calendars sync on this interval while Portly is open in this browser\./)).toBeInTheDocument();
    expect(screen.queryByText('Subscriptions (ICS)')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs the Portly server/)).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Calendars' })).toHaveAttribute('href', '#/settings/calendars');
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute('href', '#/settings/accounts');
    // Answered by the in-browser backend: no account, so nothing to sync and nothing to ask Graph.
    await waitFor(() => expect(requestsTo('GET /api/calendar/calendars')).toEqual([{ method: 'GET', path: '/api/calendar/calendars', search: '', status: 200 }]));
    expect(screen.queryByText("Can't reach the Portly server")).not.toBeInTheDocument();
  });

  it('offers Microsoft (calendar and launch pad sync) and Todoist on the Accounts page, with this site as the single-page-app redirect URI', async () => {
    const user = userEvent.setup();
    const { requestsTo } = await renderWithStaticBackend(<Shell />, { route: '#/settings/accounts' });
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByText('Connect Microsoft (Outlook.com) or Todoist below to see your calendars and tasks.')).toBeInTheDocument();
    const tiles = within(screen.getByRole('list', { name: 'Add a connection' })).getAllByRole('button');
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(['Connect Microsoft', 'Connect Todoist', 'Connect GitHub']);
    expect(within(tiles[0]!).getByText('Outlook.com calendar and launch pad sync')).toBeInTheDocument();
    expect(screen.getByText('Google, Yahoo, CalDAV and IMAP accounts need the Portly server on your PC.')).toBeInTheDocument();
    expect(screen.queryByText("Saved credentials can't be unlocked")).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'App registrations' })).getAllByRole('listitem')).toHaveLength(1);

    await user.click(tiles[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Connect Microsoft' });
    expect(await within(dialog).findByRole('form', { name: 'Microsoft app registration' })).toBeInTheDocument();
    expect(within(dialog).getByText('Single-page application')).toBeInTheDocument();
    expect(requestsTo('GET /api/oauth-clients/microsoft')[0]).toEqual({ method: 'GET', path: '/api/oauth-clients/microsoft', search: '', status: 200 });
    expect(requestsTo('GET /api/oauth-clients/google')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  });

  it('renders the notice frame for a mail instance in a persisted layout, next to working widgets', async () => {
    const storage = new MemoryStorage();
    const row: StoredProfile = {
      id: 'p1',
      name: 'Home',
      sort: 0,
      layout: { version: 1, items: [widget('w1', 'mail', 0, 0, 4, 8), widget('w2', 'clock', 4, 0, 4, 3), widget('w3', 'calendar', 8, 0, 4, 8)] },
      createdAt: 1,
      updatedAt: 1,
    };
    await storage.setJson('slice:profiles', [row]);
    await storage.setJson('slice:settings', { ...defaultSettings(), activeProfileId: 'p1' });

    const { requestsTo } = await renderWithStaticBackend(<Dashboard />, { storage });
    expect(await screen.findByText('Mail needs the Portly server')).toBeInTheDocument();
    expect(screen.getByText(/Not available in the browser-only build\. Remove it in edit mode\./)).toBeInTheDocument();
    expect(screen.getByText(stubWidgetText('clock'))).toBeInTheDocument();
    // The calendar runs here (Outlook.com from the browser).
    expect(screen.getByText(stubWidgetText('calendar'))).toBeInTheDocument();
    expect(screen.queryByText(stubWidgetText('mail'))).not.toBeInTheDocument();
    // The frame keeps the widget's title but offers no settings for it.
    expect(screen.getByRole('region', { name: 'Mail' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mail settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock settings' })).toBeInTheDocument();
    await settle();
    expect(requestsTo('POST /api/profiles')).toHaveLength(0);
  });
});
