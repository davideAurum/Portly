import type { ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubBoard, GitHubRepo } from '@portly/shared';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { qk } from '../../api/keys.ts';
import { createTestQueryClient, mockError, renderWithProviders, type ApiMock } from '../../test/render.tsx';
import type { QueryClient } from '@tanstack/react-query';
import { githubConfigSchema, type GitHubConfig } from './index.ts';
import GitHubWidget from './Widget.tsx';

const copied = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
vi.mock('../../lib/clipboard.ts', () => ({ copyText: copied }));

function repo(name: string, extra: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    fullName: `octo-tester/${name}`,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    pushedAt: '2026-10-30T12:00:00Z',
    defaultBranch: 'main',
    openIssues: 0,
    openPullRequests: 0,
    checks: 'success',
    latestRelease: null,
    ...extra,
  };
}

function board(repos: GitHubRepo[], extra: Partial<GitHubBoard> = {}): GitHubBoard {
  return { login: 'octo-tester', repos, total: repos.length, truncated: false, skipped: 0, ...extra };
}

let actionsHost: HTMLDivElement;
beforeEach(() => {
  actionsHost = document.createElement('div');
  document.body.appendChild(actionsHost);
});
afterEach(() => {
  actionsHost.remove();
  vi.restoreAllMocks();
});

function frame(children: ReactNode) {
  const value: WidgetFrameContextValue = { instanceId: 'w1', title: 'GitHub', openSettings: () => {}, canOpenSettings: true, actionsTarget: actionsHost };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function renderWidget(options: { repos?: ApiMock; config?: Partial<GitHubConfig>; size?: { w: number; h: number }; mocks?: Record<string, ApiMock>; queryClient?: QueryClient } = {}) {
  const setConfig = vi.fn(async () => {});
  const config = githubConfigSchema.parse(options.config ?? {});
  const result = renderWithProviders(frame(<GitHubWidget instanceId="w1" config={config} setConfig={setConfig} size={options.size ?? { w: 4, h: 7 }} editMode={false} />), {
    apiMocks: {
      'GET /api/github/token': { configured: true },
      'GET /api/github/repos': options.repos ?? board([repo('sample')]),
      ...options.mocks,
    },
    ...(options.queryClient ? { queryClient: options.queryClient } : {}),
  });
  return Object.assign(result, { setConfig });
}

async function rowNames(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Repositories' });
  return within(list)
    .getAllByRole('listitem')
    .map((row) => within(row).getByRole('link').textContent?.replace(' (open on GitHub)', '') ?? '');
}

/** By keyboard, which also proves the row's menu can be reached without a mouse. */
async function openRowMenu(name: string) {
  const user = userEvent.setup();
  (await screen.findByRole('button', { name: `Actions for ${name}` })).focus();
  await user.keyboard('{Enter}');
  return user;
}

describe('GitHub widget: setup', () => {
  it('a known "not configured" status shows the call to action at once and never asks for repositories', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.github.token(), { configured: false });
    const result = renderWidget({ mocks: { 'GET /api/github/token': { configured: false } }, queryClient });
    expect(screen.getByText('Connect GitHub')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up GitHub' })).toHaveAttribute('href', '#/settings/accounts?focus=github-status');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.requestsTo('GET /api/github/repos')).toHaveLength(0);
  });

  it('shows a skeleton on the first load', () => {
    renderWidget({ repos: () => new Promise(() => {}) });
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('a rejected token leads back to Settings', async () => {
    renderWidget({ repos: mockError(409, 'not_configured', 'GitHub rejected the saved token.', { details: { reason: 'token_rejected' } }) });
    expect(await screen.findByText('GitHub token rejected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up GitHub' })).toBeInTheDocument();
  });

  it('a token short of a permission says so', async () => {
    renderWidget({ repos: mockError(409, 'not_configured', 'GitHub accepted the token, but it may not read Issues.', { details: { reason: 'insufficient_scope', permissions: ['Issues'] } }) });
    expect(await screen.findByText('GitHub token needs more access')).toBeInTheDocument();
    expect(screen.getByText(/may not read Issues/)).toBeInTheDocument();
  });

  it('a locked vault leads to Accounts', async () => {
    renderWidget({ repos: mockError(409, 'reauth_required', 'Locked') });
    expect(await screen.findByText('Saved credentials are locked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '#/settings/accounts');
  });

  it('offers Retry on a passing failure', async () => {
    renderWidget({ repos: mockError(502, 'provider_error', 'GitHub is having problems (HTTP 503). Try again shortly.') });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps the board when a refresh fails', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.github.board(), board([repo('sample')]), { updatedAt: Date.now() - 10 * 60_000 });
    renderWidget({ repos: mockError(502, 'provider_error', 'Down'), queryClient });
    expect(await rowNames()).toEqual(['sample']);
    await waitFor(() => expect(within(actionsHost).getByRole('button', { name: /Updated/ })).toBeInTheDocument());
  });
});

describe('GitHub widget: the board', () => {
  it('puts what needs attention first and counts it', async () => {
    renderWidget({
      repos: board([
        repo('calm', { pushedAt: '2026-11-01T00:00:00Z' }),
        repo('broken', { pushedAt: '2026-01-01T00:00:00Z', checks: 'failure' }),
        repo('building', { pushedAt: '2026-02-01T00:00:00Z', checks: 'pending' }),
      ]),
    });
    expect(await rowNames()).toEqual(['broken', 'building', 'calm']);
    expect(screen.getByText('3 repositories')).toBeInTheDocument();
    expect(screen.getByText('1 failing')).toBeInTheDocument();
    expect(screen.getByText('1 running')).toBeInTheDocument();
  });

  it('says each CI result in words, not only in color', async () => {
    renderWidget({ repos: board([repo('a', { checks: 'failure' }), repo('b', { checks: 'none' }), repo('c', { checks: 'unavailable' })]) });
    await screen.findByRole('list', { name: 'Repositories' });
    expect(screen.getByRole('img', { name: 'CI failing' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'No CI checks' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'CI result not available' })).toBeInTheDocument();
  });

  it('says when this token can\'t read CI results, and only then', async () => {
    const first = renderWidget({ repos: board([repo('a', { checks: 'none' })]) });
    await screen.findByRole('list', { name: 'Repositories' });
    expect(screen.queryByText(/can’t read some CI results/)).not.toBeInTheDocument();
    first.unmount();
    renderWidget({ repos: board([repo('a', { checks: 'unavailable' })]) });
    expect(await screen.findByText(/can’t read some CI results/)).toBeInTheDocument();
  });

  it('shows open work, the release and privacy on the row', async () => {
    renderWidget({ repos: board([repo('sample', { isPrivate: true, openPullRequests: 2, openIssues: 5, latestRelease: { tag: 'v1.0.0', publishedAt: null } })]) });
    const list = await screen.findByRole('list', { name: 'Repositories' });
    expect(within(list).getByText('Private')).toBeInTheDocument();
    expect(within(list).getByTitle('2 open pull requests')).toHaveTextContent('2');
    expect(within(list).getByTitle('5 open issues')).toHaveTextContent('5');
    expect(within(list).getByText('v1.0.0')).toBeInTheDocument();
  });

  it('links each name to its repository', async () => {
    renderWidget({ repos: board([repo('sample')]) });
    const link = await screen.findByRole('link', { name: /sample/ });
    expect(link).toHaveAttribute('href', 'https://github.com/octo-tester/sample');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides archived repositories and forks, and says how to show them when nothing is left', async () => {
    renderWidget({ repos: board([repo('old', { isArchived: true }), repo('borrowed', { isFork: true })]) });
    expect(await screen.findByText('No repositories to show')).toBeInTheDocument();
    expect(screen.getByText(/Show them in this widget’s settings/)).toBeInTheDocument();
  });

  it('shows them when asked', async () => {
    renderWidget({ repos: board([repo('old', { isArchived: true }), repo('borrowed', { isFork: true })]), config: { showArchived: true, showForks: true, sort: 'name' } });
    expect(await rowNames()).toEqual(['borrowed', 'old']);
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Fork')).toBeInTheDocument();
  });

  it('says what was left out', async () => {
    renderWidget({ repos: board([repo('sample')], { total: 900, truncated: true, skipped: 2 }) });
    expect(await screen.findByText(/Showing the 1 most recently pushed of 900 repositories\. 2 repositories could not be read\./)).toBeInTheDocument();
  });

  it('fits a small card: no summary, no notes', async () => {
    renderWidget({ repos: board([repo('sample', { checks: 'unavailable' })]), size: { w: 3, h: 3 } });
    await screen.findByRole('list', { name: 'Repositories' });
    expect(screen.queryByText('1 repository')).not.toBeInTheDocument();
    expect(screen.queryByText(/can’t read some CI results/)).not.toBeInTheDocument();
  });

  it('changes the order from the header menu, by keyboard too', async () => {
    const h = renderWidget();
    await screen.findByRole('list', { name: 'Repositories' });
    const user = userEvent.setup();
    within(actionsHost).getByRole('button', { name: 'Sort and board options' }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: 'Name' }));
    expect(h.setConfig).toHaveBeenCalledWith({ sort: 'name' });
  });
});

describe('GitHub widget: operations', () => {
  it('hands the repository to GitHub Desktop', async () => {
    const assign = vi.fn();
    renderWidget();
    const user = await openRowMenu('sample');
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    await user.click(await screen.findByRole('menuitem', { name: 'Open in GitHub Desktop' }));
    expect(assign).toHaveBeenCalledExactlyOnceWith('x-github-client://openRepo/https://github.com/octo-tester/sample');
  });

  it.each([
    ['Repository', 'https://github.com/octo-tester/sample'],
    ['Actions', 'https://github.com/octo-tester/sample/actions'],
    ['Pull requests', 'https://github.com/octo-tester/sample/pulls'],
    ['Issues', 'https://github.com/octo-tester/sample/issues'],
    ['Releases', 'https://github.com/octo-tester/sample/releases'],
  ])('opens %s on GitHub in a new tab', async (item, url) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWidget();
    const user = await openRowMenu('sample');
    await user.click(await screen.findByRole('menuitem', { name: item }));
    expect(open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
  });

  it('copies the clone address', async () => {
    copied.mockReset();
    copied.mockResolvedValue(true);
    renderWidget();
    const user = await openRowMenu('sample');
    await user.click(await screen.findByRole('menuitem', { name: 'Copy clone address' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith('https://github.com/octo-tester/sample.git'));
    expect(await screen.findByText('Clone address copied.')).toBeInTheDocument();
  });

  it('shows open counts in the menu', async () => {
    renderWidget({ repos: board([repo('sample', { openPullRequests: 4 })]) });
    await openRowMenu('sample');
    expect(await screen.findByRole('menuitem', { name: /Pull requests/ })).toHaveTextContent('4');
  });
});
