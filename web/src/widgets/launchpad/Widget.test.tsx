import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark, BookmarkGroup, BookmarksResponse, Settings } from '@portly/shared';
import { moveInGroups } from '../../api/bookmarks.ts';
import { mockError, mockResponse, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { BookmarkDialog } from './BookmarkDialog.tsx';
import { launchpadConfigSchema, type LaunchpadConfig } from './index.ts';
import LaunchpadWidget from './Widget.tsx';
import widgetSource from './Widget.tsx?raw';
import tilesSource from './tiles.tsx?raw';

/** How often each SiteIcon rendered, by label (the real icon renders; this only counts). */
const iconRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('./SiteIcon.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SiteIcon.tsx')>();
  function CountedSiteIcon(props: Parameters<typeof actual.SiteIcon>[0]) {
    iconRenders.set(props.label, (iconRenders.get(props.label) ?? 0) + 1);
    return <actual.SiteIcon {...props} />;
  }
  return { ...actual, SiteIcon: CountedSiteIcon };
});

function bm(id: string, groupId: string, sort: number, extra: Partial<Bookmark> = {}): Bookmark {
  return { id, groupId, title: id, url: `https://${id.toLowerCase()}.example/`, sort, iconMode: 'auto', iconId: null, letterColor: null, ...extra };
}

function makeGroups(): BookmarkGroup[] {
  return [
    { id: 'g1', name: 'Work', sort: 0, color: '#3b82f6', collapsed: false, bookmarks: [bm('A', 'g1', 0), bm('B', 'g1', 1), bm('C', 'g1', 2)] },
    { id: 'g2', name: 'Fun', sort: 1, color: null, collapsed: false, bookmarks: [bm('X', 'g2', 0), bm('Y', 'g2', 1)] },
  ];
}

/** A tiny in-memory bookmarks server. */
function bookmarksServer(initial = makeGroups()) {
  let groups = structuredClone(initial);
  let counter = 0;
  return {
    get groups() {
      return groups;
    },
    mocks: {
      'GET /api/bookmarks': () => ({ groups: structuredClone(groups) }) satisfies BookmarksResponse,
      'POST /api/bookmarks/:id/move': (req: MockRequest) => {
        const body = req.body as { groupId: string; index: number };
        groups = moveInGroups(groups, req.params.id!, body.groupId, body.index);
        return { groups: structuredClone(groups) };
      },
      'DELETE /api/bookmarks/:id': (req: MockRequest) => {
        groups = groups.map((g) => ({ ...g, bookmarks: g.bookmarks.filter((b) => b.id !== req.params.id).map((b, sort) => ({ ...b, sort })) }));
        return mockResponse(204);
      },
      'POST /api/bookmarks': (req: MockRequest) => {
        const body = req.body as { groupId: string; title: string; url: string };
        const created = bm(`new-${++counter}`, body.groupId, 0, { title: body.title, url: body.url });
        groups = groups.map((g) => (g.id === body.groupId ? { ...g, bookmarks: [...g.bookmarks, { ...created, sort: g.bookmarks.length }] } : g));
        return created;
      },
      'PATCH /api/bookmark-groups/:id': (req: MockRequest) => {
        groups = groups.map((g) => (g.id === req.params.id ? { ...g, ...(req.body as object) } : g));
        return groups.find((g) => g.id === req.params.id);
      },
    } as Record<string, unknown>,
  };
}

function renderWidget(options: { config?: Partial<LaunchpadConfig>; editMode?: boolean; settings?: Partial<Settings>; mocks?: Record<string, unknown> } = {}) {
  const server = bookmarksServer();
  const base = makeSettings();
  const config = launchpadConfigSchema.parse(options.config ?? {});
  const result = renderWithProviders(
    <LaunchpadWidget instanceId="lp" config={config} setConfig={async () => {}} size={{ w: 8, h: 6 }} editMode={options.editMode ?? false} />,
    { apiMocks: { 'GET /api/settings': { ...base, ...options.settings }, ...server.mocks, ...options.mocks } },
  );
  return { ...result, server, user: userEvent.setup() };
}

describe('Launch pad: view mode', () => {
  it('renders group headers and bookmark links (current tab by default)', async () => {
    renderWidget();
    const link = await screen.findByRole('link', { name: /^A/ });
    expect(link).toHaveAttribute('href', 'https://a.example/');
    expect(link).not.toHaveAttribute('target');
    expect(screen.getByRole('button', { name: /Work/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Fun/ })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('opens links in a new tab (noopener) when general.openLinksInNewTab is on', async () => {
    const base = makeSettings();
    renderWidget({ settings: { general: { ...base.general, openLinksInNewTab: true } } });
    const link = await screen.findByRole('link', { name: /^A/ });
    await waitFor(() => expect(link).toHaveAttribute('target', '_blank'));
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never renders unsafe URLs as links', async () => {
    const groups = makeGroups();
    groups[0]!.bookmarks[0] = bm('A', 'g1', 0, { url: 'javascript:alert(1)' });
    renderWidget({ mocks: { 'GET /api/bookmarks': { groups } } });
    await screen.findByRole('link', { name: /^B/ });
    expect(screen.queryByRole('link', { name: /^A/ })).toBeNull();
    expect(screen.getByTitle('A')).toBeInTheDocument();
  });

  it('collapses a group optimistically', async () => {
    const { user, requestsTo } = renderWidget();
    const toggle = await screen.findByRole('button', { name: /Work/ });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /^A/ })).toBeNull();
    await waitFor(() => expect(requestsTo('PATCH /api/bookmark-groups/g1')[0]?.body).toEqual({ collapsed: true }));
  });

  it('shows only the configured groups and hides the header for a single group', async () => {
    renderWidget({ config: { groupIds: ['g2'] } });
    await screen.findByRole('link', { name: /^X/ });
    expect(screen.queryByRole('link', { name: /^A/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Fun/ })).toBeNull();
  });

  it('shows the empty state with an import link', async () => {
    renderWidget({ mocks: { 'GET /api/bookmarks': { groups: [] } } });
    expect(await screen.findByText('No bookmarks yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Import bookmarks/ })).toHaveAttribute('href', '#/settings/bookmarks');
    expect(screen.getByRole('button', { name: 'Add bookmark' })).toBeInTheDocument();
  });

  it('keeps element ids unique when two launch pads show the same groups', async () => {
    const server = bookmarksServer();
    const config = launchpadConfigSchema.parse({});
    const pad = (id: string) => <LaunchpadWidget instanceId={id} config={config} setConfig={async () => {}} size={{ w: 8, h: 6 }} editMode={false} />;
    renderWithProviders(
      <>
        {pad('one')}
        {pad('two')}
      </>,
      { apiMocks: { 'GET /api/settings': makeSettings(), ...server.mocks } },
    );
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^A/ })).toHaveLength(2));
    const controls = screen.getAllByRole('button', { name: /Work/ }).map((b) => b.getAttribute('aria-controls'));
    expect(new Set(controls).size).toBe(2);
    for (const id of controls) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it('adds from the empty state into a group this launch pad shows', async () => {
    const groups = makeGroups();
    groups[1]!.bookmarks = [];
    const { user } = renderWidget({ config: { groupIds: ['g2'] }, mocks: { 'GET /api/bookmarks': { groups } } });
    await user.click(await screen.findByRole('button', { name: 'Add bookmark' }));
    const dialog = await screen.findByRole('dialog');
    // Before the fix the empty state used the global default (the first group, "Work"), so the new
    // bookmark landed in a group this launch pad does not show.
    expect(within(dialog).getByRole('combobox', { name: 'Group' })).toHaveValue('g2');
  });

  it('shows an error state with Retry when the list cannot load', async () => {
    renderWidget({ mocks: { 'GET /api/bookmarks': mockError(500, 'internal', 'Boom') } });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Edit mode: dnd-kit keyboard moves (jsdom has no layout: rects are faked per group/item)
// ---------------------------------------------------------------------------

function fakeLayout() {
  const rect = (x: number, y: number, w: number, h: number) =>
    ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  const measure = (el: Element): DOMRect => {
    // The drag overlay starts where the dragged tile is.
    if (el.closest('[data-lp-overlay]') || el.querySelector('[data-lp-overlay]')) {
      const dragged = document.querySelector('[data-dragging="true"]');
      return dragged ? measure(dragged) : rect(0, 0, 0, 0);
    }
    const section = el.closest('[data-group-id]');
    if (!section) return rect(0, 0, 0, 0);
    const sections = [...document.querySelectorAll('[data-group-id]')];
    const gi = sections.indexOf(section);
    const item = el.closest('[data-bookmark-id]');
    if (!item) return rect(0, gi * 300, 800, 260);
    const items = [...section.querySelectorAll('[data-bookmark-id]')];
    return rect(items.indexOf(item) * 100, gi * 300 + 40, 90, 90);
  };
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return measure(this);
  });
}

describe('Launch pad: group layout and list options', () => {
  const sections = () => [...document.querySelectorAll<HTMLElement>('section[data-group-id]')];

  it('shows the chosen groups in the order this launch pad lists them', async () => {
    renderWidget({ config: { groupIds: ['g2', 'g1'] } });
    await screen.findByRole('link', { name: /^X/ });
    expect(sections().map((s) => s.dataset.groupId)).toEqual(['g2', 'g1']);
  });

  it('lays groups side by side with per-group widths (fixed group columns only)', async () => {
    const { container } = renderWidget({ config: { groupLayout: 'columns', groupColumns: 3, groupSpans: { g1: 2, g2: 6 } } });
    await screen.findByRole('link', { name: /^A/ });
    const board = container.querySelector<HTMLElement>('[data-group-layout]')!;
    expect(board.dataset.groupLayout).toBe('columns');
    expect(board.style.getPropertyValue('--lp-group-columns')).toBe('3');
    const [work, fun] = sections();
    expect(work!.style.getPropertyValue('--lp-span')).toBe('2');
    expect(fun!.style.getPropertyValue('--lp-span')).toBe('3'); // clamped to the column count
  });

  it('ignores group widths with automatic group columns', async () => {
    renderWidget({ config: { groupLayout: 'columns', groupSpans: { g1: 2 } } });
    await screen.findByRole('link', { name: /^A/ });
    expect(sections()[0]!.dataset.span).toBeUndefined();
  });

  it('shows "No group" bookmarks first, without a header', async () => {
    const groups = [...makeGroups(), { id: 'g-none', name: 'No group', sort: 2, color: null, collapsed: false, bookmarks: [bm('N', 'g-none', 0)] }];
    const base = makeSettings();
    renderWidget({ settings: { bookmarks: { ...base.bookmarks, ungroupedGroupId: 'g-none' } }, mocks: { 'GET /api/bookmarks': { groups } } });
    await screen.findByRole('link', { name: /^N/ });
    await waitFor(() => expect(sections()[0]!.dataset.groupId).toBe('g-none'));
    expect(screen.queryByRole('button', { name: /No group/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Work/ })).toBeInTheDocument();
  });

  it('can hide group headers', async () => {
    renderWidget({ config: { showGroupHeaders: false } });
    await screen.findByRole('link', { name: /^A/ });
    expect(screen.queryByRole('button', { name: /Work/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Work' })).toBeInTheDocument();
  });

  it('list rows show the name and domain by default', async () => {
    const { container } = renderWidget({ config: { style: 'list' } });
    const link = await screen.findByRole('link', { name: /^A/ });
    expect(link).toHaveTextContent('Aa.example');
    expect(link.querySelector('img, [aria-hidden]')).not.toBeNull();
    expect(container.querySelector('[data-density="normal"]')).not.toBeNull();
  });

  it('list rows can hide the page name and address (the link keeps the name as its label)', async () => {
    renderWidget({ config: { style: 'list', listTitle: false, listDetail: 'none' } });
    const link = await screen.findByRole('link', { name: 'A' });
    expect(link).toHaveAttribute('aria-label', 'A');
    expect(link).not.toHaveTextContent('a.example');
  });

  it('list rows can show the full URL under the name, without icons', async () => {
    const groups = makeGroups();
    groups[0]!.bookmarks[0] = bm('A', 'g1', 0, { url: 'https://www.a.example/inbox?x=1' });
    renderWidget({ config: { style: 'list', listDetail: 'url', listDetailPlacement: 'below', listIcons: false }, mocks: { 'GET /api/bookmarks': { groups } } });
    const link = await screen.findByRole('link', { name: /^A/ });
    expect(link).toHaveTextContent('Aa.example/inbox?x=1');
    expect(link.firstElementChild?.children).toHaveLength(2); // name and address stacked
  });

  it('a list row never ends up empty: with everything off it shows the name', async () => {
    renderWidget({ config: { style: 'list', listTitle: false, listDetail: 'none', listIcons: false } });
    const link = await screen.findByRole('link', { name: /^A/ });
    expect(link).toHaveTextContent('A');
  });
});

describe('Launch pad: edit mode', () => {
  beforeEach(() => {
    fakeLayout();
  });
  afterEach(() => vi.restoreAllMocks());

  const handle = (name: string) => screen.findByRole('button', { name: `${name}. Drag to reorder` });

  it('reorders within a group with the keyboard via POST /move (optimistic)', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true });
    const a = await handle('A');
    a.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[Space]');
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/A/move')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks/A/move')[0]!.body).toEqual({ groupId: 'g1', index: 1 });
    await waitFor(() => {
      const work = document.querySelector('[data-group-id="g1"]')!;
      expect([...work.querySelectorAll('[data-bookmark-id]')].map((el) => el.getAttribute('data-bookmark-id'))).toEqual(['B', 'A', 'C']);
    });
  });

  it('moves across groups with the keyboard', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true });
    const b = await handle('B');
    b.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowDown]');
    await user.keyboard('[Space]');
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/B/move')).toHaveLength(1));
    const body = requestsTo('POST /api/bookmarks/B/move')[0]!.body as { groupId: string; index: number };
    expect(body.groupId).toBe('g2');
    await waitFor(() => {
      const fun = document.querySelector('[data-group-id="g2"]')!;
      expect([...fun.querySelectorAll('[data-bookmark-id]')].map((el) => el.getAttribute('data-bookmark-id'))).toContain('B');
    });
  });

  it('rolls back and shows a toast when the move fails', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true, mocks: { 'POST /api/bookmarks/:id/move': mockError(422, 'validation_failed', 'Nope') } });
    const a = await handle('A');
    a.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[Space]');
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/A/move')).toHaveLength(1));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
    await waitFor(() => {
      const work = document.querySelector('[data-group-id="g1"]')!;
      expect([...work.querySelectorAll('[data-bookmark-id]')].map((el) => el.getAttribute('data-bookmark-id'))).toEqual(['A', 'B', 'C']);
    });
  });

  it('cancels a keyboard drag with Escape (no request)', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true });
    const a = await handle('A');
    a.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('{Escape}');
    await new Promise((r) => setTimeout(r, 50));
    expect(requestsTo('POST /api/bookmarks/A/move')).toHaveLength(0);
  });

  it('marks the droppable area so grid dragging never starts inside it', async () => {
    renderWidget({ editMode: true });
    await handle('A');
    expect(document.querySelector('[data-group-id="g1"]')!.closest('[data-no-grid-drag]')).not.toBeNull();
  });

  it('deletes with Undo (re-creates the bookmark at its old position)', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true });
    await user.click(await screen.findByRole('button', { name: 'Delete B' }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmarks/B')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'B. Drag to reorder' })).toBeNull();
    const toast = await screen.findByText('Deleted “B”');
    const undo = within(toast.closest('li') ?? document.body).getByRole('button', { name: 'Undo' });
    fireEvent.click(undo);
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ groupId: 'g1', title: 'B', url: 'https://b.example/' });
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/new-1/move')[0]?.body).toEqual({ groupId: 'g1', index: 1 }));
    expect(await handle('B')).toBeInTheDocument();
  });

  it('offers add, edit and delete actions for groups and bookmarks', async () => {
    renderWidget({ editMode: true });
    expect(await screen.findByRole('button', { name: 'Add bookmark to Work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit group Work' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete group Fun' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument();
    // Tiles are not links in edit mode.
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('Launch pad: tile menu outside edit mode (UX-6)', () => {
  it('right-click opens Edit / Move to / Delete for a tile without entering edit mode', async () => {
    const { user, requestsTo } = renderWidget();
    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('link', { name: /^B/ }) });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Delete/ }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmarks/B')).toHaveLength(1));
    expect((await screen.findAllByText('Deleted “B”')).length).toBeGreaterThan(0);
  });

  it('moves a bookmark to another group from the menu', async () => {
    const { user, requestsTo } = renderWidget();
    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('link', { name: /^A/ }) });
    await screen.findByRole('menu');
    // Edit… → Move to → (submenu) Fun
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: 'Fun' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/A/move')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks/A/move')[0]!.body).toEqual({ groupId: 'g2', index: 2 });
  });

  it('Shift+F10 opens the menu from the focused link (keyboard)', async () => {
    const { user } = renderWidget();
    const link = await screen.findByRole('link', { name: /^C/ });
    link.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('opening a dialog from one tile re-renders no other tile', async () => {
    const { user } = renderWidget();
    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('link', { name: /^X/ }) });
    const before = iconRenders.get('B');
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Edit/ }));
    expect(await screen.findByRole('dialog', { name: 'Edit bookmark' })).toBeInTheDocument();
    expect(before).toBeGreaterThan(0);
    expect(iconRenders.get('B')).toBe(before);
  });

  it('Edit… opens the dialog, which can delete too', async () => {
    const { user, requestsTo } = renderWidget();
    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('link', { name: /^X/ }) });
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit bookmark' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmarks/X')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit bookmark' })).toBeNull());
  });
});

describe('Launch pad: edit mode delete guard (UX-6)', () => {
  it('briefly ignores clicks on the tiles that slide under the pointer after a delete', async () => {
    const { user, requestsTo } = renderWidget({ editMode: true });
    await user.click(await screen.findByRole('button', { name: 'Delete B' }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmarks/B')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Delete C' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New bookmark in Work' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete C' })).toBeEnabled());
  });
});

// ---------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------

describe('Bookmark dialog', () => {
  it('autofills title and icon from site meta (debounced) and creates the bookmark', async () => {
    const onOpenChange = vi.fn();
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={onOpenChange} groups={makeGroups()} groupId="g2" />, {
      apiMocks: {
        'GET /api/site-meta': { title: 'Example Domain', iconId: '11111111-1111-4111-8111-111111111111' },
        'POST /api/bookmarks': (req: MockRequest) => ({ ...bm('new', 'g2', 2), ...(req.body as object) }),
        'GET /api/bookmarks': { groups: makeGroups() },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Example Domain'));
    const metaCalls = requestsTo('GET /api/site-meta');
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]!.search).toBe(`?url=${encodeURIComponent('https://example.com/')}`);
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('g2');

    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toEqual({
      groupId: 'g2',
      title: 'Example Domain',
      url: 'https://example.com/',
      iconMode: 'auto',
      iconId: '11111111-1111-4111-8111-111111111111',
      letterColor: null,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('files a bookmark under "No group" (creating that group once and recording it in settings)', async () => {
    const base = makeSettings();
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={makeGroups()} groupId="g1" />, {
      apiMocks: {
        'GET /api/settings': base,
        'PATCH /api/settings': (req: MockRequest) => ({ ...base, bookmarks: { ...base.bookmarks, ...(req.body as { bookmarks: object }).bookmarks } }),
        'GET /api/site-meta': { title: null, iconId: null },
        'POST /api/bookmark-groups': { id: 'g-none', name: 'No group', sort: 2, color: null, collapsed: false, bookmarks: [] },
        'POST /api/bookmarks': (req: MockRequest) => ({ ...bm('new', 'g-none', 0), ...(req.body as object) }),
        'GET /api/bookmarks': { groups: makeGroups() },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    const group = screen.getByRole('combobox', { name: 'Group' });
    expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['No group', 'Work', 'Fun', 'New group…']);
    await user.selectOptions(group, 'No group');
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmark-groups')[0]!.body).toEqual({ name: 'No group' });
    expect(requestsTo('PATCH /api/settings')[0]!.body).toEqual({ bookmarks: { ungroupedGroupId: 'g-none' } });
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ groupId: 'g-none' });
  });

  it('reuses the existing "No group" group', async () => {
    const groups = [...makeGroups(), { id: 'g-none', name: 'No group', sort: 2, color: null, collapsed: false, bookmarks: [] }];
    const base = makeSettings();
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={groups} groupId="g-none" />, {
      apiMocks: {
        'GET /api/settings': { ...base, bookmarks: { ...base.bookmarks, ungroupedGroupId: 'g-none' } },
        'GET /api/site-meta': { title: null, iconId: null },
        'POST /api/bookmarks': (req: MockRequest) => ({ ...bm('new', 'g-none', 0), ...(req.body as object) }),
        'GET /api/bookmarks': { groups },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('__none__'));
    expect(screen.getAllByRole('option').filter((o) => o.textContent === 'No group')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmark-groups')).toHaveLength(0);
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ groupId: 'g-none' });
  });

  it('"New group…" asks for a name, creates the group and adds the bookmark to it', async () => {
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={makeGroups()} />, {
      apiMocks: {
        'GET /api/site-meta': { title: null, iconId: null },
        'POST /api/bookmark-groups': (req: MockRequest) => ({ id: 'g-new', sort: 2, color: null, collapsed: false, bookmarks: [], ...(req.body as object) }),
        'POST /api/bookmarks': (req: MockRequest) => ({ ...bm('new', 'g-new', 0), ...(req.body as object) }),
        'GET /api/bookmarks': { groups: makeGroups() },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group' }), 'New group…');
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    expect(await screen.findByText('Give the new group a name.')).toBeInTheDocument();
    expect(requestsTo('POST /api/bookmarks')).toHaveLength(0);
    await user.type(screen.getByRole('textbox', { name: /New group name/ }), 'Finance');
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmark-groups')[0]!.body).toEqual({ name: 'Finance' });
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ groupId: 'g-new' });
  });

  it('keeps a title the user typed and supports letter tiles', async () => {
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={makeGroups()} />, {
      apiMocks: {
        'GET /api/site-meta': { title: 'Fetched title', iconId: null },
        'POST /api/bookmarks': (req: MockRequest) => ({ ...bm('new', 'g1', 3), ...(req.body as object) }),
        'GET /api/bookmarks': { groups: makeGroups() },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'My own');
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'news.example');
    await waitFor(() => expect(requestsTo('GET /api/site-meta')).toHaveLength(1));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('My own');
    await user.click(screen.getByRole('radio', { name: 'Letter' }));
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ title: 'My own', url: 'https://news.example/', iconMode: 'letter', iconId: null });
  });

  it('reports what "Fetch the website icon again" found (the server runs its favicon chain)', async () => {
    const bookmark = bm('A', 'g1', 0, { iconId: '11111111-1111-4111-8111-111111111111' });
    let next: string | null = '22222222-2222-4222-8222-222222222222';
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={makeGroups()} bookmark={bookmark} />, {
      apiMocks: {
        'POST /api/bookmarks/A/refresh-icon': () => ({ ...bookmark, iconId: next }),
        'GET /api/bookmarks': { groups: makeGroups() },
      },
    });
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Fetch the website icon again' });
    await user.click(button);
    expect(await screen.findByText('Icon refreshed')).toBeInTheDocument();
    next = null;
    await user.click(button);
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/A/refresh-icon')).toHaveLength(2));
    expect(await screen.findByText('No icon found for this site')).toBeInTheDocument();
    expect(screen.queryByText(/DuckDuckGo/)).not.toBeInTheDocument();
  });

  it('refuses unsafe addresses', async () => {
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={makeGroups()} />, { apiMocks: {} });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    expect(await screen.findByText(/Enter a web address/)).toBeInTheDocument();
    expect(requestsTo('POST /api/bookmarks')).toHaveLength(0);
    expect(requestsTo('GET /api/site-meta')).toHaveLength(0);
  });
});

describe('Launch pad: chunk split (PERF-1)', () => {
  /** Static imports only (`import … from '…'`), not `import('…')`. */
  const staticImports = (source: string) => [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]!);

  it('keeps @dnd-kit and the dialogs out of the view chunk (loaded lazily)', () => {
    for (const source of [widgetSource, tilesSource]) {
      const imports = staticImports(source);
      expect(imports.length).toBeGreaterThan(3);
      expect(imports.filter((spec) => spec.startsWith('@dnd-kit'))).toEqual([]);
      expect(imports.filter((spec) => /EditBoard|BookmarkDialog|GroupDialog/.test(spec))).toEqual([]);
    }
    expect(widgetSource).toContain("import('./EditBoard.tsx')");
    expect(widgetSource).toContain("import('./BookmarkDialog.tsx')");
  });

  it('switches from the view board to the edit board and back', async () => {
    fakeLayout();
    const server = bookmarksServer();
    const config = launchpadConfigSchema.parse({});
    const pad = (editMode: boolean) => <LaunchpadWidget instanceId="lp" config={config} setConfig={async () => {}} size={{ w: 8, h: 6 }} editMode={editMode} />;
    const { rerender } = renderWithProviders(pad(false), { apiMocks: { 'GET /api/settings': makeSettings(), ...server.mocks } });
    expect(await screen.findByRole('link', { name: /^A/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'A. Drag to reorder' })).toBeNull();
    rerender(pad(true));
    expect(await screen.findByRole('button', { name: 'A. Drag to reorder' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    rerender(pad(false));
    expect(await screen.findByRole('link', { name: /^A/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('moveInGroups', () => {
  it('matches the server semantics (clamp, renumber both groups)', () => {
    const moved = moveInGroups(makeGroups(), 'A', 'g2', 99);
    expect(moved[0]!.bookmarks.map((b) => [b.id, b.sort])).toEqual([
      ['B', 0],
      ['C', 1],
    ]);
    expect(moved[1]!.bookmarks.map((b) => [b.id, b.sort, b.groupId])).toEqual([
      ['X', 0, 'g2'],
      ['Y', 1, 'g2'],
      ['A', 2, 'g2'],
    ]);
    expect(moveInGroups(makeGroups(), 'C', 'g1', 0)[0]!.bookmarks.map((b) => b.id)).toEqual(['C', 'A', 'B']);
    expect(moveInGroups(makeGroups(), 'missing', 'g1', 0)).toEqual(makeGroups());
  });
});
