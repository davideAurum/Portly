import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BookmarkGroup, BookmarkImportSource } from '@homebase/shared';
import { saveBlob } from '../../lib/download.ts';
import BookmarksSettings from '../../settings/sections/Bookmarks.tsx';
import { createFakeServer } from '../../test/fakeServer.ts';
import { mockResponse, renderWithProviders, type MockRequest } from '../../test/render.tsx';

vi.mock('../../lib/download.ts', () => ({ saveBlob: vi.fn() }));

const SOURCES: BookmarkImportSource[] = [
  { id: 'src-chrome', browser: 'chrome', profileName: 'Personal', bookmarkCount: 42 },
  { id: 'src-edge', browser: 'edge', profileName: 'Work', bookmarkCount: 1 },
];

const GROUPS: BookmarkGroup[] = [
  { id: 'g1', name: 'Work', sort: 0, color: '#3b82f6', collapsed: false, bookmarks: [] },
  { id: 'g2', name: 'Fun', sort: 1, color: null, collapsed: false, bookmarks: [] },
];

function setup(extra: Record<string, unknown> = {}) {
  const server = createFakeServer([]);
  const result = renderWithProviders(<BookmarksSettings />, {
    apiMocks: {
      ...server.mocks,
      'GET /api/bookmarks': { groups: GROUPS },
      'GET /api/bookmarks/import/sources': SOURCES,
      'POST /api/bookmarks/import/browser': { groups: 3, bookmarks: 40, skipped: 2 },
      'POST /api/bookmarks/import/html': { groups: 1, bookmarks: 5, skipped: 1 },
      'POST /api/bookmark-groups/reorder': (req: MockRequest) => ({
        groups: (req.body as { ids: string[] }).ids.map((id, sort) => ({ ...GROUPS.find((g) => g.id === id)!, sort })),
      }),
      'DELETE /api/bookmark-groups/:id': mockResponse(204),
      ...extra,
    },
  });
  return { ...result, server, user: userEvent.setup() };
}

describe('Settings → Bookmarks', () => {
  it('imports from a detected browser profile with the chosen strategy and shows the report', async () => {
    const { user, requestsTo } = setup();
    expect(await screen.findByText('Chrome — Personal')).toBeInTheDocument();
    expect(screen.getByText('42 bookmarks')).toBeInTheDocument();
    expect(screen.getByText('Edge — Work')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'A single group' }));
    await user.click(screen.getByRole('button', { name: 'Import from Chrome — Personal' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/import/browser')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks/import/browser')[0]!.body).toEqual({ sourceId: 'src-chrome', targetGroupStrategy: 'single' });
    const report = await screen.findByRole('group', { name: 'Import report' }).catch(() => screen.getByLabelText('Import report'));
    expect(within(report).getByText('40')).toBeInTheDocument();
    expect(screen.getByText('Imported 40 bookmarks from Chrome — Personal')).toBeInTheDocument();
  });

  it('uploads an exported HTML file', async () => {
    const { user, requestsTo } = setup();
    const input = await screen.findByLabelText('Choose file…');
    await user.upload(input, new File(['<!DOCTYPE NETSCAPE-Bookmark-file-1><DL></DL>'], 'bookmarks.html', { type: 'text/html' }));
    expect(screen.getByText('bookmarks.html')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import file' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks/import/html')).toHaveLength(1));
    const body = requestsTo('POST /api/bookmarks/import/html')[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('targetGroupStrategy')).toBe('folders');
    expect((body.get('file') as File).name).toBe('bookmarks.html');
    expect(await screen.findByText('Imported 5 bookmarks from bookmarks.html')).toBeInTheDocument();
  });

  it('says so when no browser profiles are found', async () => {
    setup({ 'GET /api/bookmarks/import/sources': [] });
    expect(await screen.findByText('No Chrome or Edge profiles found')).toBeInTheDocument();
  });

  it('reorders and deletes groups', async () => {
    const { user, requestsTo } = setup();
    await user.click(await screen.findByRole('button', { name: 'Move Work down' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmark-groups/reorder')[0]?.body).toEqual({ ids: ['g2', 'g1'] }));
    await user.click(screen.getByRole('button', { name: 'Delete Fun' }));
    await user.click(await screen.findByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(requestsTo('DELETE /api/bookmark-groups/g2')).toHaveLength(1));
  });

  it('exports every group as a bookmark HTML file', async () => {
    const withBookmarks: BookmarkGroup[] = [
      {
        ...GROUPS[0]!,
        bookmarks: [{ id: 'b1', groupId: 'g1', title: 'Docs', url: 'https://docs.example/', sort: 0, iconMode: 'auto', iconId: null, letterColor: null }],
      },
      GROUPS[1]!,
    ];
    const { user } = setup({ 'GET /api/bookmarks': { groups: withBookmarks } });
    const button = await screen.findByRole('button', { name: 'Export bookmarks' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]!;
    expect(filename).toMatch(/^homebase-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);
    const html = await blob.text();
    expect(html).toContain('>Work</H3>');
    expect(html).toContain('<A HREF="https://docs.example/"');
    expect(await screen.findByText('Exported 1 bookmark.')).toBeInTheDocument();
  });

  it('disables the export when there are no bookmarks', async () => {
    setup();
    await screen.findByRole('list', { name: 'Bookmark groups' });
    expect(screen.getByRole('button', { name: 'Export bookmarks' })).toBeDisabled();
  });

  it('saves the default group and the automatic icon preference', async () => {
    const { user, requestsTo } = setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'New bookmarks go to' }), 'g2');
    await waitFor(() => expect(requestsTo('PATCH /api/settings')[0]?.body).toEqual({ bookmarks: { defaultGroupId: 'g2' } }));
    await user.click(screen.getByRole('switch', { name: 'Fetch website icons automatically' }));
    await waitFor(() => expect(requestsTo('PATCH /api/settings')[1]?.body).toEqual({ bookmarks: { autoFetchIcons: false } }));
  });
});
