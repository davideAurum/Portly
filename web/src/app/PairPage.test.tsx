/**
 * The pairing page (`#/pair?nonce=…`): its states on Portly's own page (pairing off, a bad link,
 * the approval), the one-second arming of Approve (re-armed after blur or a hidden tab), approving
 * (POST, then back to the Pages site only through an accepted redirect), Cancel, the Pages build's
 * note, and App routing to it.
 */
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildPairingReturnUrl, type PairingsResponse } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { settings } from '../test/fixtures.ts';
import { mockError, renderWithProviders } from '../test/render.tsx';
import { App } from './App.tsx';
import { APPROVE_ARM_DELAY_MS, PairPage, useAttendedFor } from './PairPage.tsx';

const NONCE = 'n'.repeat(43);
const PAGES_URL = 'https://user.github.io/portly/';
const REDIRECT = buildPairingReturnUrl(PAGES_URL, { token: 't'.repeat(43), nonce: NONCE, instanceId: 'instance-1' });

function pairings(overrides: Partial<PairingsResponse> = {}): PairingsResponse {
  return { pagesUrl: PAGES_URL, instanceId: 'instance-1', pairings: [], ...overrides };
}

/** Drives `document.visibilityState` and `document.hasFocus()` (jsdom has no real window focus). */
function attention(initial: { visible?: boolean; focused?: boolean } = {}) {
  const state = { visible: initial.visible ?? true, focused: initial.focused ?? true };
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (state.visible ? 'visible' : 'hidden'));
  vi.spyOn(document, 'hasFocus').mockImplementation(() => state.focused);
  return {
    blur() {
      state.focused = false;
      fireEvent.blur(window);
    },
    focus() {
      state.focused = true;
      fireEvent.focus(window);
    },
    hide() {
      state.visible = false;
      fireEvent(document, new Event('visibilitychange'));
    },
    show() {
      state.visible = true;
      fireEvent(document, new Event('visibilitychange'));
    },
  };
}

function stubAssign() {
  const assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
  return assign;
}

/** Waits (real time) for Approve to arm. */
async function armedApprove(): Promise<HTMLElement> {
  const approve = await screen.findByRole('button', { name: 'Approve' });
  await waitFor(() => expect(approve).toBeEnabled(), { timeout: APPROVE_ARM_DELAY_MS + 2000 });
  return approve;
}

describe('useAttendedFor', () => {
  it('arms after the delay while the page is visible and focused', () => {
    attention();
    vi.useFakeTimers();
    const { result } = renderHook(() => useAttendedFor(1000));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('disarms on blur and waits the full delay again after focus returns', () => {
    const page = attention();
    vi.useFakeTimers();
    const { result } = renderHook(() => useAttendedFor(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(true);

    act(() => page.blur());
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(false);

    act(() => page.focus());
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('disarms while the tab is hidden', () => {
    const page = attention();
    vi.useFakeTimers();
    const { result } = renderHook(() => useAttendedFor(1000));
    act(() => vi.advanceTimersByTime(500));
    // Hidden halfway through: the first half does not count.
    act(() => page.hide());
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(false);
    act(() => page.show());
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('ignores events that leave the page visible and focused', () => {
    attention();
    vi.useFakeTimers();
    const { result } = renderHook(() => useAttendedFor(1000));
    act(() => vi.advanceTimersByTime(600));
    // e.g. focus moving within the page: the count is not restarted.
    act(() => {
      fireEvent.blur(window);
      fireEvent(document, new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(400));
    expect(result.current).toBe(true);
    act(() => fireEvent.focus(window));
    expect(result.current).toBe(true);
  });

  it('stays unarmed while the window has no focus, and leaves no timer behind', () => {
    const page = attention({ focused: false });
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAttendedFor(1000));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
    act(() => page.focus());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PairPage on Portly’s own page', () => {
  it('explains how to turn pairing on when no Pages address is configured', async () => {
    const { requestsTo } = renderWithProviders(<PairPage nonce={NONCE} />, { apiMocks: { 'GET /api/pairings': pairings({ pagesUrl: null }) } });
    expect(await screen.findByRole('heading', { name: 'Pairing is turned off' })).toBeInTheDocument();
    expect(screen.getByText('PORTLY_PAGES_URL')).toBeInTheDocument();
    expect(screen.getByText('scripts/install-autostart.ps1')).toBeInTheDocument();
    // The installer replaces the task, in Browser mode unless told otherwise.
    expect(screen.getByText('-Trigger Logon')).toBeInTheDocument();
    expect(screen.getByText('docs/setup/pages-local-server.md')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '#/');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(requestsTo('POST /api/pairings')).toEqual([]);
  });

  it('refuses a link without a valid nonce and offers a way back', async () => {
    const { requests } = renderWithProviders(<PairPage nonce={null} />, { apiMocks: { 'GET /api/pairings': pairings() } });
    expect(await screen.findByRole('heading', { name: 'This pairing link doesn’t work' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '#/');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/pairings']);
  });

  it('shows an error with Retry when the pairings cannot be read', async () => {
    renderWithProviders(<PairPage nonce={NONCE} />, { apiMocks: { 'GET /api/pairings': mockError(500, 'internal', 'Boom') } });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('names the origin being trusted, warns that it covers every page there, and lists what it can and cannot do', async () => {
    renderWithProviders(<PairPage nonce={NONCE} />, { apiMocks: { 'GET /api/pairings': pairings() } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Allow this site to use Portly on this PC?' })).toBeInTheDocument();
    expect(screen.getByText('https://user.github.io', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(PAGES_URL)).toBeInTheDocument();
    const warning = screen.getByRole('alert');
    expect(within(warning).getByText('Every page on https://user.github.io gets this access')).toBeInTheDocument();
    expect(warning).toHaveTextContent('not only your Pages site');

    const can = screen.getByRole('heading', { name: 'It will be able to' }).nextElementSibling as HTMLElement;
    expect(within(can).getAllByRole('listitem').map((li) => li.textContent)).toContain('See and change your dashboards, settings, bookmarks and uploads');
    const cannot = screen.getByRole('heading', { name: 'It won’t be able to' }).nextElementSibling as HTMLElement;
    expect(within(cannot).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Connect accounts or set up OAuth clients',
      'Reset the credential vault',
      'Pair or unpair browsers',
      'See where Portly keeps its files on this PC',
    ]);
    expect(screen.getByRole('link', { name: 'Settings → About' })).toHaveAttribute('href', '#/settings/about');
  });

  it('keeps Approve disabled while the window is not focused', async () => {
    attention({ focused: false });
    renderWithProviders(<PairPage nonce={NONCE} />, { apiMocks: { 'GET /api/pairings': pairings() } });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await new Promise((resolve) => setTimeout(resolve, APPROVE_ARM_DELAY_MS + 200));
    expect(approve).toBeDisabled();
  });

  it('arms Approve after a second of attention, re-arms after a blur, and approving sends the tab back to the Pages site', async () => {
    const page = attention();
    const user = userEvent.setup();
    const assign = stubAssign();
    const { requestsTo } = renderWithProviders(<PairPage nonce={NONCE} />, {
      apiMocks: { 'GET /api/pairings': pairings(), 'POST /api/pairings': { redirectUrl: REDIRECT } },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    await armedApprove();

    page.blur();
    expect(approve).toBeDisabled();
    page.focus();
    expect(approve).toBeDisabled();
    await armedApprove();

    await user.click(approve);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(requestsTo('POST /api/pairings').map((r) => r.body)).toEqual([{ nonce: NONCE }]);
    // On its way out: no second approval.
    expect(approve).toBeDisabled();
  });

  it('does not follow a redirect outside the Pages address and says so', async () => {
    attention();
    const user = userEvent.setup();
    const assign = stubAssign();
    renderWithProviders(<PairPage nonce={NONCE} />, {
      apiMocks: { 'GET /api/pairings': pairings(), 'POST /api/pairings': { redirectUrl: `https://evil.example/${REDIRECT.slice(REDIRECT.indexOf('#'))}` } },
    });
    await user.click(await armedApprove());
    const error = await screen.findByText('This browser was not paired');
    expect(error.closest('[role="alert"]')).toHaveTextContent('unexpected address');
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal', async () => {
    attention();
    const user = userEvent.setup();
    renderWithProviders(<PairPage nonce={NONCE} />, {
      apiMocks: { 'GET /api/pairings': pairings(), 'POST /api/pairings': mockError(409, 'not_configured', 'Pairing with a Pages site is off.') },
    });
    await user.click(await armedApprove());
    expect(await screen.findByText('Pairing with a Pages site is off.')).toBeInTheDocument();
  });

  it('Cancel goes back to the dashboard without pairing', async () => {
    const user = userEvent.setup();
    const { requestsTo } = renderWithProviders(<PairPage nonce={NONCE} />, {
      route: `#/pair?nonce=${NONCE}`,
      apiMocks: { 'GET /api/pairings': pairings() },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(window.location.hash).toBe('#/');
    expect(requestsTo('POST /api/pairings')).toEqual([]);
  });
});

describe('PairPage in the Pages build', () => {
  it.each(['browser', 'server'] as const)('only explains where pairing happens, with a way back to the dashboard (%s backend)', (backend) => {
    setCapabilitiesForTests(capabilitiesFor(true, backend));
    const { requests } = renderWithProviders(<PairPage nonce={NONCE} />);
    expect(screen.getByRole('heading', { name: 'Pairing happens on Portly’s own page' })).toBeInTheDocument();
    expect(screen.getByText(/Pair this browser/)).toBeInTheDocument();
    // The only link is back to the dashboard: no link out to a page on this PC.
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Back to the dashboard']);
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '#/');
    expect(screen.queryByText(/Open Portly on this PC/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('App', () => {
  it('renders the pairing page on its own for #/pair', async () => {
    renderWithProviders(<App />, {
      route: `#/pair?nonce=${NONCE}`,
      apiMocks: { 'GET /api/pairings': pairings(), 'GET /api/settings': settings() },
    });
    expect(await screen.findByRole('heading', { name: 'Allow this site to use Portly on this PC?' })).toBeInTheDocument();
    // No dashboard chrome around the consent screen.
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});
