import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, MusicDevice, MusicPlayback, MusicStatus } from '@portly/shared';
import { MUSIC_SETTLE_MS } from '../../api/music.ts';
import { qk } from '../../api/keys.ts';
import { shouldPersistQuery } from '../../app/providers.tsx';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { definition, musicConfigSchema, type MusicConfig } from './index.ts';
import MusicSettings from './Settings.tsx';
import MusicWidget from './Widget.tsx';

const DEVICE: MusicDevice = { id: 'desk', name: 'Desk PC', type: 'computer', active: true, restricted: false, volumePercent: 40 };
const PHONE: MusicDevice = { id: 'phone', name: 'Phone', type: 'phone', active: false, restricted: false, volumePercent: null };

const PLAYBACK: MusicPlayback = {
  isPlaying: true,
  positionMs: 30_000,
  item: {
    kind: 'track',
    title: 'Harbor Lights at Dawn',
    artists: ['The Paper Lanterns', 'Ada Example'],
    album: 'Tide Tables',
    durationMs: 200_000,
    artworkUrl: 'https://i.scdn.co/image/medium',
    url: 'https://open.spotify.com/track/abc123',
  },
  device: DEVICE,
  shuffle: false,
  repeat: 'off',
  allowed: { pause: true, resume: true, next: true, previous: true, seek: true, shuffle: true, repeat: true },
};

const FEATURES = { seek: true, volume: true, shuffle: true, repeat: true, devices: true };

function status(playback: Partial<MusicPlayback> | null = {}, features: Partial<typeof FEATURES> = {}): MusicStatus {
  return { accountId: 'a1', provider: 'spotify', features: { ...FEATURES, ...features }, playback: playback === null ? null : { ...PLAYBACK, ...playback } };
}

/** The frame's header slot, so `WidgetActions` has somewhere to render. */
function Frame({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const value: WidgetFrameContextValue = { instanceId: 'w1', title: 'Music', openSettings: () => {}, canOpenSettings: true, actionsTarget: target };
  return (
    <WidgetFrameContext.Provider value={value}>
      <div ref={setTarget} data-testid="actions" />
      {children}
    </WidgetFrameContext.Provider>
  );
}

function renderWidget(mocks: Record<string, ApiMock>, options: { config?: Partial<MusicConfig>; size?: { w: number; h: number } } = {}) {
  const config = musicConfigSchema.parse(options.config ?? {});
  const result = renderWithProviders(
    <Frame>
      <MusicWidget instanceId="w1" config={config} setConfig={async () => {}} size={options.size ?? { w: 4, h: 5 }} editMode={false} />
    </Frame>,
    { apiMocks: { 'GET /api/accounts': [], ...mocks } },
  );
  return { ...result, user: userEvent.setup() };
}

afterEach(() => vi.useRealTimers());

describe('music widget: playing', () => {
  it('shows the item, links back to Spotify, and keeps the logo there', async () => {
    renderWidget({ 'GET /api/music/status': status() });
    const title = await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    expect(title).toHaveAttribute('href', 'https://open.spotify.com/track/abc123');
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('The Paper Lanterns, Ada Example')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Harbor Lights at Dawn in Spotify' })).toHaveAttribute('href', 'https://open.spotify.com/track/abc123');
    const logo = within(screen.getByTestId('actions')).getByRole('link', { name: 'Open in Spotify' });
    expect(logo).toHaveAttribute('href', 'https://open.spotify.com/track/abc123');
    expect(logo.querySelector('svg')).not.toBeNull();
  });

  it('shows the cover art with nothing on top of it', async () => {
    const { container } = renderWidget({ 'GET /api/music/status': status() });
    await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://i.scdn.co/image/medium');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image?.parentElement?.children).toHaveLength(1);
  });

  it('falls back to a placeholder when the art fails to load, and tries the next item’s', async () => {
    const { container, queryClient } = renderWidget({ 'GET /api/music/status': status() });
    await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    act(() => void queryClient.setQueryData(qk.music.status(null), status({ item: { ...PLAYBACK.item!, artworkUrl: 'https://i.scdn.co/image/other' } })));
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://i.scdn.co/image/other'));
  });

  it('shows plain text, not a link, for an item with no page or an unsafe one', async () => {
    renderWidget({ 'GET /api/music/status': status({ item: { ...PLAYBACK.item!, url: 'javascript:alert(1)' } }) });
    expect(await screen.findByText('Harbor Lights at Dawn')).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'Harbor Lights at Dawn' })).not.toBeInTheDocument();
  });

  it('copes with no item (an advert, a private session)', async () => {
    renderWidget({ 'GET /api/music/status': status({ item: null }) });
    expect(await screen.findByText('Waiting for the next item')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Position' })).not.toBeInTheDocument();
  });

  it('moves the position on by itself', async () => {
    renderWidget({ 'GET /api/music/status': status() });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    expect(slider).toHaveValue('30');
    expect(slider).toHaveAttribute('max', '200');
    expect(slider).toHaveAttribute('aria-valuetext', '0:30 / 3:20');
  });
});

describe('music widget: commands', () => {
  const accept = { 'POST /api/music/command': mockResponse(204) };
  const sent = (requests: MockRequest[]) => requests.map((r) => (r.body as { command: unknown }).command);

  it('pauses at once, before Spotify answers', async () => {
    const { user, requestsTo } = renderWidget({ 'GET /api/music/status': status(), ...accept });
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
    await waitFor(() => expect(sent(requestsTo('POST /api/music/command'))).toEqual([{ type: 'pause' }]));
  });

  it('names the widget’s own account', async () => {
    const { user, requestsTo } = renderWidget({ 'GET /api/music/status': status(), ...accept }, { config: { accountId: 'a2' } });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(requestsTo('POST /api/music/command')[0]?.body).toEqual({ accountId: 'a2', command: { type: 'next' } }));
    expect(requestsTo('GET /api/music/status')[0]?.search).toBe('?accountId=a2');
  });

  it('skips, shuffles and cycles repeat', async () => {
    const { user, requestsTo } = renderWidget({ 'GET /api/music/status': status(), ...accept });
    await user.click(await screen.findByRole('button', { name: 'Previous' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Shuffle is off' }));
    await user.click(screen.getByRole('button', { name: 'Repeat is off' }));
    await user.click(await screen.findByRole('button', { name: 'Repeating all' }));
    await waitFor(() =>
      expect(sent(requestsTo('POST /api/music/command'))).toEqual([
        { type: 'previous' },
        { type: 'next' },
        { type: 'shuffle', on: true },
        { type: 'repeat', mode: 'context' },
        { type: 'repeat', mode: 'track' },
      ]),
    );
    expect(screen.getByRole('button', { name: 'Shuffle is on' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('puts things back and says why when a command is refused', async () => {
    const { user } = renderWidget({
      'GET /api/music/status': status(),
      'POST /api/music/command': mockError(403, 'forbidden', 'Spotify only lets Premium accounts control playback', { details: { reason: 'premium_required' } }),
    });
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Spotify only lets Premium accounts control playback')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('reads the state again once Spotify has had a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, requestsTo } = renderWidget({ 'GET /api/music/status': status(), ...accept });
    const button = await screen.findByRole('button', { name: 'Pause' });
    await user.click(button);
    await waitFor(() => expect(requestsTo('POST /api/music/command')).toHaveLength(1));
    const before = requestsTo('GET /api/music/status').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MUSIC_SETTLE_MS + 50);
    });
    await waitFor(() => expect(requestsTo('GET /api/music/status').length).toBeGreaterThan(before));
  });

  it('does not throw the bar back when a press restarts its clock', async () => {
    const realNow = Date.now.bind(Date);
    const { user, queryClient } = renderWidget({ 'GET /api/music/status': status({ positionMs: 30_000 }), ...accept });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    expect(slider).toHaveValue('30');
    // Twelve seconds into playing, between two polls.
    const later = realNow() + 12_000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await user.click(screen.getByRole('button', { name: 'Shuffle is off' }));
    await screen.findByRole('button', { name: 'Shuffle is on' });
    const stored = queryClient.getQueryData<MusicStatus>(qk.music.status(null));
    expect(stored?.playback?.positionMs).toBeGreaterThanOrEqual(41_000);
    expect(stored?.playback?.positionMs).toBeLessThanOrEqual(43_000);
  });

  it('sends one seek when the slider is let go, not one per step', async () => {
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), ...accept });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.change(slider, { target: { value: '90' } });
    expect(requestsTo('POST /api/music/command')).toEqual([]);
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(sent(requestsTo('POST /api/music/command'))).toEqual([{ type: 'seek', positionMs: 90_000 }]));
  });

  it('commits a drag that ends with the pointer off the slider', async () => {
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), ...accept });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    fireEvent.change(slider, { target: { value: '120' } });
    fireEvent.pointerUp(document.body);
    await waitFor(() => expect(sent(requestsTo('POST /api/music/command'))).toEqual([{ type: 'seek', positionMs: 120_000 }]));
  });

  it('commits a key press too', async () => {
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), ...accept });
    const slider = await screen.findByRole('slider', { name: 'Volume' });
    fireEvent.change(slider, { target: { value: '45' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(sent(requestsTo('POST /api/music/command'))).toEqual([{ type: 'volume', percent: 45 }]));
  });

  it('sends nothing when a slider is left unchanged', async () => {
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), ...accept });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider, { key: 'Tab' });
    fireEvent.blur(slider);
    expect(requestsTo('POST /api/music/command')).toEqual([]);
  });
});

describe('music widget: what the provider allows', () => {
  it('disables what Spotify refuses right now', async () => {
    renderWidget({ 'GET /api/music/status': status({ allowed: { ...PLAYBACK.allowed, next: false, seek: false, shuffle: false } }) });
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Shuffle is off' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Position' })).toBeDisabled();
  });

  it('hides what a provider cannot do at all', async () => {
    renderWidget({ 'GET /api/music/status': status({}, { shuffle: false, repeat: false, volume: false, devices: false }) });
    await screen.findByRole('button', { name: 'Pause' });
    expect(screen.queryByRole('button', { name: /Shuffle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Repeat/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Volume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change device/ })).not.toBeInTheDocument();
  });

  it('shows no volume for a device without one, or when the widget is narrow', async () => {
    const { unmount } = renderWidget({ 'GET /api/music/status': status({ device: PHONE }) });
    await screen.findByRole('button', { name: 'Pause' });
    expect(screen.queryByRole('slider', { name: 'Volume' })).not.toBeInTheDocument();
    unmount();
    renderWidget({ 'GET /api/music/status': status() }, { size: { w: 3, h: 5 } });
    await screen.findByRole('button', { name: 'Pause' });
    expect(screen.queryByRole('slider', { name: 'Volume' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Position' })).toBeInTheDocument();
  });

  it('keeps the essentials at the smallest size', async () => {
    renderWidget({ 'GET /api/music/status': status() }, { size: { w: 3, h: 3 } });
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Change device/ })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Shuffle/ })).not.toBeInTheDocument();
  });

  it('shows the album when there is room', async () => {
    renderWidget({ 'GET /api/music/status': status() }, { size: { w: 4, h: 7 } });
    expect(await screen.findByText('Tide Tables')).toBeInTheDocument();
  });
});

describe('music widget: devices', () => {
  /**
   * Radix closes a menu when the window loses focus, and jsdom fires a false window `blur` when focus
   * arrives from nowhere. A browser's focus always comes from somewhere: start from the trigger.
   */
  async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const trigger = await screen.findByRole('button', { name: /Change device/ });
    act(() => trigger.focus());
    await user.click(trigger);
  }

  it('asks for devices only when the picker opens, and moves playback', async () => {
    const { user, requestsTo } = renderWidget({
      'GET /api/music/status': status(),
      'GET /api/music/devices': [DEVICE, PHONE],
      'POST /api/music/command': mockResponse(204),
    });
    expect(await screen.findByRole('button', { name: 'Playing on Desk PC. Change device' })).toBeInTheDocument();
    expect(requestsTo('GET /api/music/devices')).toEqual([]);
    await openPicker(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Phone' }));
    await waitFor(() => expect(requestsTo('POST /api/music/command')[0]?.body).toEqual({ command: { type: 'transfer', deviceId: 'phone', play: true } }));
  });

  it('keeps a paused state paused on the new device', async () => {
    const { user, requestsTo } = renderWidget({
      'GET /api/music/status': status({ isPlaying: false }),
      'GET /api/music/devices': [DEVICE, PHONE],
      'POST /api/music/command': mockResponse(204),
    });
    await openPicker(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Phone' }));
    await waitFor(() => expect(requestsTo('POST /api/music/command')[0]?.body).toEqual({ command: { type: 'transfer', deviceId: 'phone', play: false } }));
  });

  it('sends nothing when the device already playing is picked, and disables a restricted one', async () => {
    const { user, requestsTo } = renderWidget({
      'GET /api/music/status': status(),
      'GET /api/music/devices': [DEVICE, { ...PHONE, restricted: true }],
    });
    await openPicker(user);
    expect(await screen.findByRole('menuitem', { name: 'Phone' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: /Desk PC/ }));
    expect(requestsTo('POST /api/music/command')).toEqual([]);
  });

  it('says so when no device answers', async () => {
    const { user } = renderWidget({ 'GET /api/music/status': status(), 'GET /api/music/devices': [] });
    await openPicker(user);
    expect(await screen.findByText('No other device is online')).toBeInTheDocument();
  });
});

describe('music widget: nothing playing', () => {
  it('offers the devices that are online', async () => {
    const { user, requestsTo } = renderWidget({
      'GET /api/music/status': status(null),
      'GET /api/music/devices': [PHONE, { ...DEVICE, id: 'desk', active: false }, { ...DEVICE, id: 'locked', name: 'Locked', restricted: true }],
      'POST /api/music/command': mockResponse(204),
    });
    expect(await screen.findByText('Nothing is playing')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Play on Phone' }));
    expect(screen.queryByRole('button', { name: 'Play on Locked' })).not.toBeInTheDocument();
    await waitFor(() => expect(requestsTo('POST /api/music/command')[0]?.body).toEqual({ command: { type: 'transfer', deviceId: 'phone', play: true } }));
  });

  it('offers as many devices as fit at each height', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ ...PHONE, id, name: `Device ${id}` }));
    const offered = async (h: number) => {
      const { unmount } = renderWidget({ 'GET /api/music/status': status(null), 'GET /api/music/devices': many }, { size: { w: 4, h } });
      await screen.findByRole('button', { name: 'Play on Device a' });
      const count = screen.getAllByRole('button', { name: /^Play on/ }).length;
      unmount();
      return count;
    };
    expect(await offered(3)).toBe(1);
    expect(await offered(4)).toBe(2);
    expect(await offered(7)).toBe(4);
  });

  it('links to Spotify when no device is online', async () => {
    renderWidget({ 'GET /api/music/status': status(null), 'GET /api/music/devices': [] });
    expect(await screen.findByRole('link', { name: /Open Spotify/ })).toHaveAttribute('href', 'https://open.spotify.com/');
    expect(within(screen.getByTestId('actions')).getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute('href', 'https://open.spotify.com/');
  });
});

describe('music widget: problems', () => {
  it('asks to connect Spotify, linking to its connect dialog', async () => {
    renderWidget({ 'GET /api/music/status': mockError(409, 'not_configured', 'Connect a music service', { details: { reason: 'no_account' } }) });
    expect(await screen.findByRole('link', { name: 'Connect Spotify' })).toHaveAttribute('href', '#/settings/accounts?focus=spotify');
    expect(screen.getByText('No music service connected')).toBeInTheDocument();
  });

  it('offers Reconnect for the account that needs it', async () => {
    const account = { id: 'a1', kind: 'spotify', label: 'Sam', status: 'reauth' } as Account;
    renderWidget({ 'GET /api/accounts': [account], 'GET /api/music/status': mockError(409, 'reauth_required', 'Reconnect', { accountId: 'a1' }) });
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(await screen.findByText('Reconnect Sam')).toBeInTheDocument();
  });

  it('says why when Spotify refuses the account, and can try again', async () => {
    const { user, requestsTo } = renderWidget({
      'GET /api/music/status': mockError(403, 'forbidden', 'Spotify refused access. The Spotify app’s owner needs Premium', { details: { reason: 'access_denied' } }),
    });
    expect(await screen.findByText('Spotify refused access')).toBeInTheDocument();
    expect(screen.getByText(/app’s owner needs Premium/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(requestsTo('GET /api/music/status')).toHaveLength(2));
  });

  it('offers Retry for anything else', async () => {
    renderWidget({ 'GET /api/music/status': mockError(502, 'provider_error', 'Spotify returned an error (500)') });
    expect(await screen.findByText('Spotify returned an error (500)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps showing the last state, marked stale, when a refresh fails', async () => {
    const answers: ApiMock[] = [status(), mockError(502, 'provider_error', 'Spotify returned an error (500)')];
    const { queryClient } = renderWidget({ 'GET /api/music/status': () => answers.shift() ?? mockError(502, 'provider_error', 'Spotify returned an error (500)') });
    await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.music.status(null) });
    });
    expect(await within(screen.getByTestId('actions')).findByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Harbor Lights at Dawn' })).toBeInTheDocument();
  });
});

describe('music widget: privacy', () => {
  it('never writes what is playing to the persisted cache', async () => {
    const { queryClient } = renderWidget({ 'GET /api/music/status': status(), 'GET /api/music/devices': [DEVICE] });
    await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    const query = queryClient.getQueryCache().find({ queryKey: qk.music.status(null) });
    expect(query).toBeDefined();
    expect(shouldPersistQuery(query!)).toBe(false);
  });
});

describe('music widget: definition and settings', () => {
  it('defaults to the first account, and shrugs off a bad stored value', () => {
    expect(musicConfigSchema.parse({})).toEqual({ accountId: null });
    expect(musicConfigSchema.parse({ accountId: 5 })).toEqual({ accountId: null });
    expect(definition).toMatchObject({ type: 'music', title: 'Music', defaultSize: { w: 4, h: 4, minW: 3, minH: 3 } });
  });

  const account = (id: string, label: string, capability = 'music') => ({ id, kind: 'spotify', label, enabledCapabilities: [capability] }) as unknown as Account;

  it('has nothing to choose with one account', async () => {
    renderWithProviders(<MusicSettings value={{ accountId: null }} onChange={() => {}} />, { apiMocks: { 'GET /api/accounts': [account('a1', 'Sam')] } });
    expect(await screen.findByText(/uses your connected music account/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('picks between accounts, ignoring those with music switched off', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<MusicSettings value={{ accountId: null }} onChange={onChange} />, {
      apiMocks: { 'GET /api/accounts': [account('a1', 'Sam'), account('a2', 'Robin'), account('g1', 'Work', 'mail')] },
    });
    const select = await screen.findByRole('combobox', { name: 'Account' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['First connected account', 'Sam', 'Robin']);
    await user.selectOptions(select, 'a2');
    expect(onChange).toHaveBeenCalledWith({ accountId: 'a2' });
  });
});
