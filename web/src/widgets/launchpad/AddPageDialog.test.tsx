import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark, BookmarkGroup } from '@homebase/shared';
import { renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { AddPageDialog } from './AddPageDialog.tsx';
import { clearAddBookmarkRequest, parseAddBookmarkRequest } from './addRequest.ts';

function groups(): BookmarkGroup[] {
  return [
    { id: 'g1', name: 'Work', sort: 0, color: null, collapsed: false, bookmarks: [] },
    { id: 'g2', name: 'Reading', sort: 1, color: null, collapsed: false, bookmarks: [] },
  ];
}

const hashOf = (params: Record<string, string>) => `#/add-bookmark?${new URLSearchParams(params).toString()}`;

describe('parseAddBookmarkRequest', () => {
  it('reads the address and title', () => {
    expect(parseAddBookmarkRequest(hashOf({ url: 'https://example.com/a?b=1#c', title: '  An   article ' }))).toEqual({
      url: 'https://example.com/a?b=1#c',
      title: 'An article',
    });
    expect(parseAddBookmarkRequest(hashOf({ url: 'http://nas.local:8080/' }))).toEqual({ url: 'http://nas.local:8080/', title: null });
  });

  it('caps the title at 300 characters', () => {
    expect(parseAddBookmarkRequest(hashOf({ url: 'https://example.com/', title: 'x'.repeat(400) }))?.title).toHaveLength(300);
  });

  it('ignores other routes and addresses that cannot be bookmarks', () => {
    expect(parseAddBookmarkRequest('#/')).toBeNull();
    expect(parseAddBookmarkRequest('#/settings/general?url=https://example.com/')).toBeNull();
    expect(parseAddBookmarkRequest('#/add-bookmark')).toBeNull();
    expect(parseAddBookmarkRequest('#/add-bookmarks?url=https://example.com/')).toBeNull();
    for (const url of ['javascript:alert(1)', 'chrome://settings', 'file:///C:/x.html', 'https://user:pw@example.com/', 'not a url', `https://example.com/${'a'.repeat(2100)}`]) {
      expect(parseAddBookmarkRequest(hashOf({ url }))).toBeNull();
    }
  });
});

describe('clearAddBookmarkRequest', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('replaces an add-bookmark hash with the dashboard and leaves other hashes alone', () => {
    window.history.replaceState(null, '', `/${hashOf({ url: 'https://example.com/' })}`);
    clearAddBookmarkRequest();
    expect(window.location.hash).toBe('#/');
    window.history.replaceState(null, '', '/#/settings/general');
    clearAddBookmarkRequest();
    expect(window.location.hash).toBe('#/settings/general');
  });
});

describe('AddPageDialog', () => {
  it('opens filled in with the page, preselects the default group, and adds it there', async () => {
    const base = makeSettings();
    const onDone = vi.fn();
    const { requestsTo } = renderWithProviders(<AddPageDialog request={{ url: 'https://example.com/post', title: 'A post' }} onDone={onDone} />, {
      apiMocks: {
        'GET /api/settings': { ...base, bookmarks: { ...base.bookmarks, defaultGroupId: 'g2' } },
        'GET /api/bookmarks': { groups: groups() },
        'GET /api/site-meta': { title: 'Example — the site', iconId: null },
        'POST /api/bookmarks': (req: MockRequest) =>
          ({ id: 'new', sort: 0, iconMode: 'auto', iconId: null, letterColor: null, ...(req.body as object) }) as Bookmark,
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('dialog', { name: 'Add bookmark' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Address/ })).toHaveValue('https://example.com/post');
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('g2');
    // The page's own title stays, even after the site's title arrives.
    await waitFor(() => expect(requestsTo('GET /api/site-meta')).toHaveLength(1));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('A post');

    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(requestsTo('POST /api/bookmarks')).toHaveLength(1));
    expect(requestsTo('POST /api/bookmarks')[0]!.body).toMatchObject({ groupId: 'g2', title: 'A post', url: 'https://example.com/post' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('takes the site title when the request has none, and ends the request on Cancel', async () => {
    const onDone = vi.fn();
    const { requestsTo } = renderWithProviders(<AddPageDialog request={{ url: 'https://example.com/', title: null }} onDone={onDone} />, {
      apiMocks: {
        'GET /api/settings': makeSettings(),
        'GET /api/bookmarks': { groups: groups() },
        'GET /api/site-meta': { title: 'Example Domain', iconId: null },
      },
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Example Domain'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestsTo('POST /api/bookmarks')).toHaveLength(0);
  });
});
