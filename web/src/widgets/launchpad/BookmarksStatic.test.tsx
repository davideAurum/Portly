/**
 * Bookmarks UI in the Pages build on its in-browser backend
 * (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`): the
 * Settings → Bookmarks import card drops the browser-profile subsection and explains where icons
 * come from, the add dialog says the title came from the address, the refresh button never claims
 * an icon was found, a DuckDuckGo icon that loads (even its placeholder for unknown sites) stays
 * shown, and `expectNewIcons` refreshes the list without starting the icon poll (icons are
 * assigned synchronously there). On the Homebase server on this PC (hybrid mode) the server's
 * behaviour comes back: browser-profile import, page titles, server-fetched icons and the poll.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark, BookmarkGroup, BookmarksResponse } from '@homebase/shared';
import { ICON_POLL_INTERVAL_MS, expectNewIcons, useBookmarks } from '../../api/bookmarks.ts';
import { qk } from '../../api/keys.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import BookmarksSettings from '../../settings/sections/Bookmarks.tsx';
import { createFakeServer } from '../../test/fakeServer.ts';
import { renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { BookmarkDialog } from './BookmarkDialog.tsx';
import { SiteIcon } from './SiteIcon.tsx';

beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

const GROUPS: BookmarkGroup[] = [
  {
    id: 'g1',
    name: 'Work',
    sort: 0,
    color: null,
    collapsed: false,
    bookmarks: [{ id: 'b1', groupId: 'g1', title: 'Nas', url: 'http://nas/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null }],
  },
];

describe('Settings → Bookmarks (static build)', () => {
  it('hides the browser-profile import and never asks for sources', async () => {
    const server = createFakeServer([]);
    const { requestsTo } = renderWithProviders(<BookmarksSettings />, {
      apiMocks: { ...server.mocks, 'GET /api/bookmarks': { groups: GROUPS }, 'GET /api/bookmarks/import/sources': [] },
    });
    expect(await screen.findByText('From an exported HTML file')).toBeInTheDocument();
    // The groups card still lists the groups ("Work" also appears as a <select> option, hence the role query).
    expect(await screen.findByRole('button', { name: 'Edit Work' })).toBeInTheDocument();
    expect(screen.queryByText('From a browser on this PC')).not.toBeInTheDocument();
    expect(screen.queryByText('No Chrome or Edge profiles found')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Look again' })).not.toBeInTheDocument();
    expect(requestsTo('GET /api/bookmarks/import/sources')).toHaveLength(0);
    // The HTML import still works.
    expect(screen.getByRole('button', { name: 'Import file' })).toBeInTheDocument();
  });

  it('explains that icons come from DuckDuckGo’s icon service and that home-network sites get a letter tile', async () => {
    const server = createFakeServer([]);
    renderWithProviders(<BookmarksSettings />, { apiMocks: { ...server.mocks, 'GET /api/bookmarks': { groups: GROUPS } } });
    const toggle = await screen.findByRole('switch', { name: 'Fetch website icons automatically' });
    expect(toggle).toBeInTheDocument();
    expect(screen.getByText(/loaded by your browser from DuckDuckGo’s icon service/)).toBeInTheDocument();
    expect(screen.getByText(/Sites on your home network are never looked up and show a letter tile/)).toBeInTheDocument();
    // DuckDuckGo's placeholder for unknown sites is a real image, not a letter tile: say so.
    expect(screen.getByText(/Sites it has no icon for show its generic placeholder; choose a letter tile or upload an icon for those/)).toBeInTheDocument();
    expect(screen.queryByText(/refreshed monthly/)).not.toBeInTheDocument();
  });
});

describe('Bookmark dialog (static build)', () => {
  it('says the title was filled in from the address and sends the synthetic icon id', async () => {
    const onOpenChange = vi.fn();
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={onOpenChange} groups={GROUPS} groupId="g1" />, {
      apiMocks: {
        'GET /api/site-meta': { title: 'Example', iconId: 'fav:example.com' },
        'POST /api/bookmarks': (req: MockRequest) =>
          ({ id: 'new', sort: 1, letterColor: null, iconMode: 'auto', iconId: null, ...(req.body as object) }) as Bookmark,
        'GET /api/bookmarks': { groups: GROUPS },
      },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Example'));
    expect(screen.getByText('Filled in from the address.')).toBeInTheDocument();
    expect(screen.queryByText('Filled in from the page.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ url: 'https://example.com/', iconMode: 'auto', iconId: 'fav:example.com' });
  });

  it('keeps the "fetch the website icon again" button, which calls the refresh route; a home-network site keeps its letter tile', async () => {
    const bookmark = GROUPS[0]!.bookmarks[0]!;
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={GROUPS} bookmark={bookmark} />, {
      apiMocks: {
        'POST /api/bookmarks/b1/refresh-icon': { ...bookmark, iconId: null },
        'GET /api/bookmarks': { groups: GROUPS },
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fetch the website icon again' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/b1/refresh-icon')).toHaveLength(1));
    expect(await screen.findByText('Sites on your home network keep their letter tile')).toBeInTheDocument();
    expect(screen.queryByText('No icon found for this site')).not.toBeInTheDocument();
  });

  it('never claims an icon was found for a public site: it only points at DuckDuckGo’s icon', async () => {
    const bookmark: Bookmark = { id: 'b2', groupId: 'g1', title: 'Tiny', url: 'https://tiny-site.example/', sort: 1, iconMode: 'auto', iconId: null, letterColor: null };
    const { requestsTo } = renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={GROUPS} bookmark={bookmark} />, {
      apiMocks: {
        'POST /api/bookmarks/b2/refresh-icon': { ...bookmark, iconId: 'fav:tiny-site.example' },
        'GET /api/bookmarks': { groups: GROUPS },
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fetch the website icon again' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/b2/refresh-icon')).toHaveLength(1));
    expect(await screen.findByText('Using DuckDuckGo’s icon for this site')).toBeInTheDocument();
    expect(screen.queryByText('Icon refreshed')).not.toBeInTheDocument();
  });
});

describe('SiteIcon (static build)', () => {
  const DDG_ICON = 'https://icons.duckduckgo.com/ip3/tiny-site.example.ico';

  it('keeps DuckDuckGo’s image once it loads: its placeholder for unknown sites (404 + PNG) fires load, not error', () => {
    // jsdom has no canvas: the tone probe falls back to "no plate".
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { container } = renderWithProviders(<SiteIcon label="Tiny" iconId="fav:tiny-site.example" size={32} />, { toaster: false });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', DDG_ICON);
    // What DuckDuckGo's 48x48 placeholder looks like to the page: a successful load.
    Object.defineProperty(img!, 'naturalWidth', { configurable: true, value: 48 });
    fireEvent.load(img!);
    expect(container.querySelector('img')).toBe(img);
    expect(container).not.toHaveTextContent('T');
  });

  it('falls back to the letter tile only when the image really fails (offline, blocked)', () => {
    const { container } = renderWithProviders(<SiteIcon label="Tiny" iconId="fav:tiny-site.example" size={32} />, { toaster: false });
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('T');
  });

  it('shows the letter tile without any request for a home-network site (no icon id)', () => {
    const { container } = renderWithProviders(<SiteIcon label="Nas" iconId={null} size={32} />, { toaster: false });
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('N');
  });
});

function BookmarkTitles() {
  const bookmarks = useBookmarks();
  return <ul>{bookmarks.data?.groups.flatMap((g) => g.bookmarks.map((b) => <li key={b.id}>{b.title}</li>))}</ul>;
}

describe('expectNewIcons (static build)', () => {
  it('refreshes the list once but does not start the icon poll', async () => {
    const { queryClient, requestsTo } = renderWithProviders(<BookmarkTitles />, {
      apiMocks: { 'GET /api/bookmarks': { groups: GROUPS } satisfies BookmarksResponse },
    });
    expect(await screen.findByText('Nas')).toBeInTheDocument();
    expect(requestsTo('GET /api/bookmarks')).toHaveLength(1);
    expectNewIcons(queryClient);
    await waitFor(() => expect(requestsTo('GET /api/bookmarks')).toHaveLength(2));
    // The list has an automatic bookmark without an icon (a home-network host), which would keep
    // the server build polling for 45 s; the static build leaves refetchInterval off.
    const query = queryClient.getQueryCache().find({ queryKey: qk.bookmarks.all(), exact: true });
    expect(query).toBeDefined();
    const interval = query!.observers[0]!.options.refetchInterval;
    expect(typeof interval).toBe('function');
    expect((interval as (q: NonNullable<typeof query>) => number | false)(query!)).toBe(false);
  });
});

describe('Bookmarks UI on the Homebase server on this PC (Pages build, hybrid mode)', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('offers the browser-profile import and describes the server’s icon fetching', async () => {
    const server = createFakeServer([]);
    const { requestsTo } = renderWithProviders(<BookmarksSettings />, {
      apiMocks: { ...server.mocks, 'GET /api/bookmarks': { groups: GROUPS }, 'GET /api/bookmarks/import/sources': [] },
    });
    expect(await screen.findByText('From a browser on this PC')).toBeInTheDocument();
    await waitFor(() => expect(requestsTo('GET /api/bookmarks/import/sources')).toHaveLength(1));
    expect(await screen.findByText(/Homebase downloads each site’s icon once \(refreshed monthly\)/)).toBeInTheDocument();
    expect(screen.queryByText(/DuckDuckGo’s icon service/)).not.toBeInTheDocument();
  });

  it('says the title came from the page', async () => {
    renderWithProviders(<BookmarkDialog open onOpenChange={() => {}} groups={GROUPS} groupId="g1" />, {
      apiMocks: { 'GET /api/site-meta': { title: 'Example', iconId: null }, 'GET /api/bookmarks': { groups: GROUPS } },
    });
    await userEvent.setup().type(screen.getByRole('textbox', { name: /Address/ }), 'example.com');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Example'));
    expect(screen.getByText('Filled in from the page.')).toBeInTheDocument();
  });

  it('expectNewIcons polls while the server is still resolving icons', async () => {
    const { queryClient } = renderWithProviders(<BookmarkTitles />, {
      apiMocks: { 'GET /api/bookmarks': { groups: GROUPS } satisfies BookmarksResponse },
    });
    expect(await screen.findByText('Nas')).toBeInTheDocument();
    expectNewIcons(queryClient, 60_000);
    const query = queryClient.getQueryCache().find({ queryKey: qk.bookmarks.all(), exact: true });
    const interval = query!.observers[0]!.options.refetchInterval as (q: NonNullable<typeof query>) => number | false;
    expect(interval(query!)).toBe(ICON_POLL_INTERVAL_MS);
    // Over again for the next test: the poll window is module state.
    expectNewIcons(queryClient, -1);
  });
});
