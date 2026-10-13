import type { ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feed } from '@portly/shared';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { mockError, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { feedsConfigSchema, type FeedsConfig } from './index.ts';
import { mergeFeedItems, normalizeFeedInput, sourceName } from './model.ts';
import FeedsSettings from './Settings.tsx';
import FeedsWidget from './Widget.tsx';

const NOW = new Date('2026-10-11T12:00:00Z').getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function feed(url: string, title: string, items: [id: string, minutesAgo: number | null, extra?: Partial<Feed['items'][number]>][]): Feed {
  return {
    url,
    feedUrl: url,
    title,
    siteUrl: null,
    fetchedAt: new Date(NOW).toISOString(),
    items: items.map(([id, minutes, extra]) => ({
      id,
      title: `Story ${id}`,
      url: `https://news.example/${id}`,
      published: minutes === null ? null : ago(minutes),
      author: null,
      summary: `Summary of ${id}`,
      ...extra,
    })),
  };
}

const TECH = feed('https://tech.example/rss', 'Tech Daily', [
  ['t1', 5],
  ['t2', 120, { url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>Plain text' }],
]);
const WORLD = feed('https://world.example/atom', 'World News', [
  ['w1', 30],
  ['w2', null],
]);

function config(patch: Partial<FeedsConfig> = {}): FeedsConfig {
  return { ...feedsConfigSchema.parse({}), ...patch };
}

function Frame({ children, openSettings }: { children: ReactNode; openSettings?: () => void }) {
  const value: WidgetFrameContextValue = {
    instanceId: 'w-feeds',
    title: 'RSS feeds',
    openSettings: openSettings ?? (() => {}),
    canOpenSettings: true,
    actionsTarget: document.body,
  };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function feedsApi(byUrl: Record<string, ApiMock>): ApiMock {
  return (req: MockRequest) => {
    const url = new URLSearchParams(req.search).get('url') ?? '';
    const mock = byUrl[url];
    return typeof mock === 'function' ? (mock as (r: MockRequest) => unknown)(req) : (mock ?? mockError(404, 'not_found'));
  };
}

function renderFeeds(cfg: Partial<FeedsConfig>, byUrl: Record<string, ApiMock> = {}, openSettings?: () => void) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return renderWithProviders(
    <Frame openSettings={openSettings}>
      <FeedsWidget instanceId="w-feeds" config={config(cfg)} setConfig={async () => {}} size={{ w: 4, h: 7 }} editMode={false} />
    </Frame>,
    { apiMocks: { 'GET /api/feeds': feedsApi(byUrl) } },
  );
}

const headlines = () => within(screen.getByRole('list', { name: 'Headlines' })).getAllByRole('listitem');

describe('feeds model', () => {
  it('merges feeds newest first, undated last, de-duplicating shared article URLs', () => {
    const dup = feed('https://dup.example/', 'Dup', [['t1', 1]]);
    const rows = mergeFeedItems(
      [
        { source: { url: TECH.url, title: '' }, feed: TECH },
        { source: { url: WORLD.url, title: 'Mine' }, feed: WORLD },
        { source: { url: dup.url, title: '' }, feed: dup },
        { source: { url: 'https://pending.example/', title: '' }, feed: undefined },
      ],
      10,
    );
    expect(rows.map((r) => `${r.item.id}@${r.source}`)).toEqual(['t1@Tech Daily', 'w1@Mine', 't2@Tech Daily', 'w2@Mine']);
    expect(mergeFeedItems([{ source: { url: TECH.url, title: '' }, feed: TECH }], 1)).toHaveLength(1);
  });

  it('names sources and normalizes typed addresses', () => {
    expect(sourceName({ url: 'https://www.site.example/feed', title: '' })).toBe('site.example');
    expect(normalizeFeedInput(' example.com/feed ')).toBe('https://example.com/feed');
    expect(normalizeFeedInput('http://x.example/')).toBe('http://x.example/');
    expect(normalizeFeedInput('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});

describe('FeedsWidget', () => {
  afterEach(() => vi.useRealTimers());

  it('asks for feeds when none are configured', async () => {
    const openSettings = vi.fn();
    renderFeeds({}, {}, openSettings);
    expect(screen.getByText('No feeds yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add feeds' }));
    expect(openSettings).toHaveBeenCalledWith({ focus: 'feed-url' });
  });

  it('shows merged headlines with sources, safe links and plain text', async () => {
    renderFeeds(
      { feeds: [{ url: TECH.url, title: '' }, { url: WORLD.url, title: '' }] },
      { [TECH.url]: TECH, [WORLD.url]: WORLD },
    );
    await waitFor(() => expect(headlines()).toHaveLength(4));
    const [first, , third] = headlines();
    expect(within(first!).getByRole('link')).toHaveAttribute('href', 'https://news.example/t1');
    expect(within(first!).getByRole('link')).toHaveAttribute('target', '_blank');
    expect(first).toHaveTextContent('Tech Daily');
    // The unsafe link renders as text, and markup in titles stays text.
    expect(within(third!).queryByRole('link')).toBeNull();
    expect(third).toHaveTextContent('<img src=x onerror=alert(1)>Plain text');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByText('Summary of t1')).toBeNull();
  });

  it('shows summaries when enabled and hides the source with a single feed', async () => {
    renderFeeds({ feeds: [{ url: TECH.url, title: '' }], showSummary: true }, { [TECH.url]: TECH });
    expect(await screen.findByText('Summary of t1')).toBeInTheDocument();
    expect(headlines()[0]).not.toHaveTextContent('Tech Daily');
  });

  it('keeps working feeds when one fails, with a Retry for the failed one', async () => {
    renderFeeds(
      { feeds: [{ url: TECH.url, title: '' }, { url: 'https://broken.example/rss', title: 'Broken' }] },
      { [TECH.url]: TECH, 'https://broken.example/rss': mockError(502, 'provider_error', 'The feed answered HTTP 500') },
    );
    expect(await screen.findByTestId('feed-error')).toHaveTextContent('BrokenThe feed answered HTTP 500');
    expect(headlines()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an error state when every feed fails', async () => {
    renderFeeds({ feeds: [{ url: 'https://broken.example/rss', title: '' }] }, { 'https://broken.example/rss': mockError(422, 'validation_failed', 'This address is not an RSS or Atom feed') });
    expect(await screen.findByText(/not an RSS or Atom feed/)).toBeInTheDocument();
  });
});

describe('FeedsSettings', () => {
  it('checks a feed before adding it and stores the discovered feed URL', async () => {
    const onChange = vi.fn();
    const discovered = { ...WORLD, url: 'https://world.example', feedUrl: WORLD.url };
    const { requestsTo } = renderWithProviders(<FeedsSettings value={config()} onChange={onChange} />, {
      apiMocks: { 'GET /api/feeds': feedsApi({ 'https://world.example': discovered, 'https://nope.example': mockError(422, 'validation_failed', 'No RSS or Atom feed was found on this page') }) },
    });
    const input = screen.getByPlaceholderText('https://example.com/feed.xml');

    await userEvent.type(input, 'nope.example{Enter}');
    expect(await screen.findByText('No RSS or Atom feed was found on this page')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // A check: the server records no failing feed for an address that was only tried.
    expect(new URLSearchParams(requestsTo('GET /api/feeds')[0]?.search).get('check')).toBe('1');

    await userEvent.clear(input);
    await userEvent.type(input, 'world.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ feeds: [{ url: WORLD.url, title: '' }] })));
  });

  it('rejects non-web addresses and duplicates without a request', async () => {
    const { requestsTo } = renderWithProviders(<FeedsSettings value={config({ feeds: [{ url: TECH.url, title: '' }] })} onChange={() => {}} />, {
      apiMocks: {},
    });
    const input = screen.getByPlaceholderText('https://example.com/feed.xml');
    await userEvent.type(input, 'javascript:alert(1){Enter}');
    expect(await screen.findByText(/Enter a web address/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, `${TECH.url}{Enter}`);
    expect(await screen.findByText('This feed is already in the list.')).toBeInTheDocument();
    expect(requestsTo('GET /api/feeds')).toHaveLength(0);
  });

  it('renames, reorders and removes feeds', async () => {
    const onChange = vi.fn();
    const feeds = [
      { url: TECH.url, title: '' },
      { url: WORLD.url, title: 'World' },
    ];
    renderWithProviders(<FeedsSettings value={config({ feeds })} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move World up' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ feeds: [feeds[1], feeds[0]] }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove tech.example' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ feeds: [feeds[1]] }));
    await userEvent.type(screen.getByRole('textbox', { name: `Name for ${TECH.url}` }), 'T');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ feeds: [{ url: TECH.url, title: 'T' }, feeds[1]] }));
  });
});
