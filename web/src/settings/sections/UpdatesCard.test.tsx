/**
 * The Updates card in every state of design/update-button.md section 1: what a page offers, that
 * only Portly's own page offers Update (the Pages site gets a link to it and never sends the
 * request), and how a page follows a run while the server is away and when it comes back.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateRun, UpdateStatusResponse } from '@portly/shared';
import { UPDATE_POLL_MS } from '../../api/update.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import { setLocalServerController } from '../../localServer/store.ts';
import type { LocalServerInfo } from '../../localServer/types.ts';
import { fakeLocalServer } from '../../test/hybrid.ts';
import { mockError, renderWithProviders } from '../../test/render.tsx';
import { NO_ANSWER_LIMIT_MS, RELOAD_DELAY_MS, UpdatesCard, ownPageUrl } from './UpdatesCard.tsx';

const SERVER: LocalServerInfo = { version: '0.2.0-alpha.8', instanceId: 'instance-1', appUrl: 'http://localhost:5757/', apiVersion: 1, vault: 'ready' };
const REMOTE = 'https://desk.tailnet.ts.net';

function status(patch: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    availability: 'ready',
    installed: '0.2.0-alpha.8',
    latest: '0.2.0-alpha.8',
    updateAvailable: false,
    notesUrl: 'https://github.com/example/portly/releases/tag/v0.2.0-alpha.8',
    checkedAt: '2026-11-05T12:00:00.000Z',
    checkFailed: false,
    run: null,
    ...patch,
  };
}

const AVAILABLE = status({
  latest: '0.2.0-alpha.9',
  updateAvailable: true,
  notesUrl: 'https://github.com/example/portly/releases/tag/v0.2.0-alpha.9',
});

function run(patch: Partial<UpdateRun> = {}): UpdateRun {
  return {
    id: 'run-1',
    state: 'requested',
    from: '0.2.0-alpha.8',
    to: '0.2.0-alpha.9',
    startedAt: '2026-11-05T12:00:00.000Z',
    finishedAt: null,
    code: null,
    extensionChanged: false,
    ...patch,
  };
}

const card = () => screen.getByRole('region', { name: 'Updates' });

afterEach(() => {
  vi.useRealTimers();
});

describe('what the card says', () => {
  it('asks when it opens, then says Portly is the latest release, and Check again asks past the cache', async () => {
    const { requestsTo } = renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': status() } });
    expect(screen.getByText('Checking for updates')).toBeInTheDocument();
    expect(await screen.findByText('Portly 0.2.0-alpha.8 is the latest release.')).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(requestsTo('GET /api/update').some((r) => r.search === '?refresh=1')).toBe(true));
  });

  it('offers a newer release with its notes', async () => {
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': AVAILABLE } });
    expect(await screen.findByText('Portly 0.2.0-alpha.9 is available.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What's new in 0.2.0-alpha.9/ })).toHaveAttribute('href', AVAILABLE.notesUrl);
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('says so when GitHub could not be reached, and offers nothing to install', async () => {
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': status({ checkFailed: true, latest: null, updateAvailable: false, notesUrl: null }) } });
    expect(await screen.findByText('Could not reach GitHub.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it.each([
    ['checkout', 'This is a Git checkout. Use portly --rebuild.'],
    ['unsupervised', 'Portly was not started by its scheduled task. Use portly --update on the main PC.'],
    ['no-task', 'The updater is not set up. Run portly --update --force on the main PC.'],
  ] as const)('%s: says what to do instead, with no button', async (availability, text) => {
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': { ...AVAILABLE, availability, latest: null, updateAvailable: false } } });
    await waitFor(() => expect(card()).toHaveTextContent(text));
    expect(within(card()).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reports a finished update, with the extension note when it changed', async () => {
    renderWithProviders(<UpdatesCard />, {
      apiMocks: { 'GET /api/update': status({ installed: '0.2.0-alpha.9', latest: '0.2.0-alpha.9', run: run({ state: 'done', extensionChanged: true }) }) },
    });
    expect(await screen.findByText('Updated to 0.2.0-alpha.9')).toBeInTheDocument();
    expect(screen.getByText('Click Reload on Portly New Tab in chrome://extensions on the main PC.')).toBeInTheDocument();
  });

  it('leaves the extension note out when it did not change', async () => {
    renderWithProviders(<UpdatesCard />, {
      apiMocks: { 'GET /api/update': status({ installed: '0.2.0-alpha.9', latest: '0.2.0-alpha.9', run: run({ state: 'done' }) }) },
    });
    expect(await screen.findByText('Updated to 0.2.0-alpha.9')).toBeInTheDocument();
    expect(screen.queryByText(/chrome:\/\/extensions/)).not.toBeInTheDocument();
  });

  it('reports a rollback, on the version it is on now', async () => {
    renderWithProviders(<UpdatesCard />, {
      apiMocks: { 'GET /api/update': { ...AVAILABLE, run: run({ state: 'rolled-back', code: 'did_not_start' }) } },
    });
    expect(await screen.findByText('0.2.0-alpha.9 did not start, so Portly went back to 0.2.0-alpha.8')).toBeInTheDocument();
    expect(screen.getByText('Your data was restored from the copy made before the update.')).toBeInTheDocument();
  });

  it.each([
    ['download_failed', 'The download failed.'],
    ['checksum_mismatch', 'The download was damaged, so nothing was installed.'],
    ['file_in_use', 'A file in use stopped the update, so nothing changed.'],
    ['not_newer', 'There was nothing newer to install.'],
    ['did_not_start', 'Portly did not start after the update. Check the main PC with portly --status.'],
    ['unknown', 'The update stopped before it finished.'],
  ] as const)('reports a failure (%s), the installed version and Try again', async (code, text) => {
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': { ...AVAILABLE, run: run({ state: 'failed', code }) } } });
    expect(await screen.findByText('Portly is still on 0.2.0-alpha.8.')).toBeInTheDocument();
    expect(card()).toHaveTextContent(text);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('stays away from a server older than the button, as the gate or the router answers it', async () => {
    for (const answer of [mockError(403, 'local_only'), mockError(404, 'not_found')]) {
      const { requestsTo, unmount } = renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': answer } });
      await waitFor(() => expect(requestsTo('GET /api/update')).toHaveLength(1));
      await waitFor(() => expect(screen.queryByText('Checking for updates')).not.toBeInTheDocument());
      expect(screen.queryByRole('region', { name: 'Updates' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows any other failure with a way to try again', async () => {
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': mockError(500, 'internal', 'Something broke') } });
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });
});

describe('starting an update', () => {
  it('asks first, then sends the version the user was shown and follows the run', async () => {
    const { requestsTo } = renderWithProviders(<UpdatesCard />, {
      apiMocks: { 'GET /api/update': AVAILABLE, 'POST /api/update': { run: run() } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Portly will stop for about a minute while it updates, on every PC using it/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/fix it on the main PC/)).not.toBeInTheDocument();
    expect(requestsTo('POST /api/update')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(requestsTo('POST /api/update')).toHaveLength(1));
    expect(requestsTo('POST /api/update')[0]?.body).toEqual({ version: '0.2.0-alpha.9' });
    expect(await screen.findByText('Starting the update')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('warns another PC that it may have to go to the main PC', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server', true));
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': AVAILABLE } });
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(await screen.findByText(/If it does not come back, you will need to fix it on the main PC/)).toBeInTheDocument();
  });

  it('a refused start says why, and the card asks again', async () => {
    const { requestsTo } = renderWithProviders(<UpdatesCard />, {
      apiMocks: { 'GET /api/update': AVAILABLE, 'POST /api/update': mockError(409, 'conflict', 'That is no longer the newest release. Check again.') },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('That is no longer the newest release. Check again.')).toBeInTheDocument();
    await waitFor(() => expect(requestsTo('GET /api/update').length).toBeGreaterThan(1));
  });
});

describe('on the Pages site', () => {
  it('links to the server page on this PC and never offers the button', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: SERVER, paired: true }).controller);
    const { requestsTo } = renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': AVAILABLE } });
    expect(await screen.findByText('Portly 0.2.0-alpha.9 is available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Portly's own page/ })).toHaveAttribute('href', 'http://localhost:5757/#/settings/about');
    expect(screen.getByText("Updates start from Portly's own page, not from this site.")).toBeInTheDocument();
    expect(requestsTo('POST /api/update')).toHaveLength(0);
  });

  it('links to the Tailscale address on another PC, and says it connects once', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server', true));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: SERVER, paired: true, remoteOrigin: REMOTE }).controller);
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': AVAILABLE } });
    expect(await screen.findByRole('link', { name: /Open Portly's own page/ })).toHaveAttribute('href', `${REMOTE}/#/settings/about`);
    expect(screen.getByText(/The first time, this PC connects there and the main PC approves it/)).toBeInTheDocument();
  });

  it('falls back to the command when the address is unknown', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: { ...SERVER, appUrl: null }, paired: true }).controller);
    renderWithProviders(<UpdatesCard />, { apiMocks: { 'GET /api/update': AVAILABLE } });
    expect(await screen.findByText('Portly 0.2.0-alpha.9 is available.')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Run portly --update on the main PC.');
    expect(screen.queryByRole('link', { name: /Open Portly's own page/ })).not.toBeInTheDocument();
  });

  it('ownPageUrl: the remote address wins over a loopback one, and there may be neither', () => {
    expect(ownPageUrl({ server: SERVER, remoteOrigin: null })).toBe('http://localhost:5757/#/settings/about');
    expect(ownPageUrl({ server: SERVER, remoteOrigin: REMOTE })).toBe(`${REMOTE}/#/settings/about`);
    expect(ownPageUrl({ server: null, remoteOrigin: undefined })).toBeNull();
  });
});

describe('following a run', () => {
  /** Lets the fake clock move a poll on, and every promise behind it settle. */
  const tick = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  it('shows each step, stays calm while the server is away, then shows the result and reloads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let answer: unknown = { ...AVAILABLE, run: run({ state: 'downloading' }) };
    const reload = vi.fn();
    renderWithProviders(<UpdatesCard reload={reload} />, { apiMocks: { 'GET /api/update': () => answer } });
    await tick(1);
    expect(screen.getByText('Downloading')).toBeInTheDocument();

    answer = { ...AVAILABLE, run: run({ state: 'installing' }) };
    await tick(UPDATE_POLL_MS);
    expect(screen.getByText('Installing')).toBeInTheDocument();

    const away = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', away);
    await tick(UPDATE_POLL_MS);
    expect(screen.getByText('Restarting Portly')).toBeInTheDocument();
    expect(screen.getByText(/a notice that it can't be reached is normal here/)).toBeInTheDocument();
    await tick(UPDATE_POLL_MS);
    expect(away.mock.calls.length).toBeGreaterThan(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(status({ installed: '0.2.0-alpha.9', latest: '0.2.0-alpha.9', run: run({ state: 'done' }) })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await tick(UPDATE_POLL_MS);
    expect(screen.getByText('Updated to 0.2.0-alpha.9')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await tick(RELOAD_DELAY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says so when Portly has not come back, and keeps asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    renderWithProviders(<UpdatesCard reload={vi.fn()} />, { apiMocks: { 'GET /api/update': { ...AVAILABLE, run: run({ state: 'restarting' }) } } });
    await tick(1);
    const away = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', away);
    await tick(NO_ANSWER_LIMIT_MS + UPDATE_POLL_MS);
    expect(screen.getByText('Portly has not come back')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Check the main PC, or run portly --status there.');
    const calls = away.mock.calls.length;
    await tick(UPDATE_POLL_MS);
    expect(away.mock.calls.length).toBeGreaterThan(calls);
  });

  it('never reloads for an old result it opened on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const reload = vi.fn();
    renderWithProviders(<UpdatesCard reload={reload} />, {
      apiMocks: { 'GET /api/update': status({ installed: '0.2.0-alpha.9', latest: '0.2.0-alpha.9', run: run({ state: 'done' }) }) },
    });
    await tick(1);
    expect(screen.getByText('Updated to 0.2.0-alpha.9')).toBeInTheDocument();
    await tick(RELOAD_DELAY_MS + UPDATE_POLL_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload after a failed run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let answer: unknown = { ...AVAILABLE, run: run({ state: 'installing' }) };
    const reload = vi.fn();
    renderWithProviders(<UpdatesCard reload={reload} />, { apiMocks: { 'GET /api/update': () => answer } });
    await tick(1);
    answer = { ...AVAILABLE, run: run({ state: 'failed', code: 'file_in_use' }) };
    await tick(UPDATE_POLL_MS);
    expect(screen.getByText('A file in use stopped the update, so nothing changed.')).toBeInTheDocument();
    await tick(RELOAD_DELAY_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it('on the Pages site refreshes what it knows instead of reloading', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    setLocalServerController(fakeLocalServer({ backend: 'server', status: 'connected', server: SERVER, paired: true }).controller);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let answer: unknown = { ...AVAILABLE, run: run({ state: 'installing' }) };
    const reload = vi.fn();
    const { queryClient } = renderWithProviders(<UpdatesCard reload={reload} />, { apiMocks: { 'GET /api/update': () => answer } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await tick(1);
    answer = status({ installed: '0.2.0-alpha.9', latest: '0.2.0-alpha.9', run: run({ state: 'done' }) });
    await tick(UPDATE_POLL_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['about'] });
    await tick(RELOAD_DELAY_MS);
    expect(reload).not.toHaveBeenCalled();
  });
});
