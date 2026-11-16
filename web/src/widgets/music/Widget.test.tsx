import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, MusicCommand, MusicDevice, MusicPlayback, MusicStatus, PhonePlayback } from '@portly/shared';
import { MUSIC_SETTLE_MS } from '../../api/music.ts';
import { qk } from '../../api/keys.ts';
import { shouldPersistQuery } from '../../app/providers.tsx';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest, type MockResponse } from '../../test/render.tsx';
import { definition, musicConfigSchema, type MusicConfig } from './index.ts';
import { applyCommand } from './model.ts';
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
    { apiMocks: { 'GET /api/accounts': [], 'GET /api/music/phone': null, ...mocks } },
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
    // The clock stands still until the test moves it: a busy machine must not move the bar first.
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    renderWidget({ 'GET /api/music/status': status() });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    expect(slider).toHaveValue('30');
    expect(slider).toHaveAttribute('max', '200');
    expect(slider).toHaveAttribute('aria-valuetext', '0:30 / 3:20');
    clock.mockReturnValue(start + 12_000);
    await waitFor(() => expect(slider).toHaveValue('42'));
    expect(slider).toHaveAttribute('aria-valuetext', '0:42 / 3:20');
  });
});

describe('music widget: commands', () => {
  const accept = { 'POST /api/music/command': mockResponse(204) };
  const sent = (requests: MockRequest[]) => requests.map((r) => (r.body as { command: unknown }).command);

  /**
   * Spotify as the widget meets it: what it accepts shows in every later read. A fixed status would
   * take a press back off the screen at the read that follows it, and a busy machine reaches that
   * read in the middle of a test.
   */
  function spotify() {
    let current = status();
    return {
      'GET /api/music/status': () => current,
      'POST /api/music/command': ({ body }: MockRequest) => {
        current = applyCommand(current, (body as { command: MusicCommand }).command);
        return mockResponse(204);
      },
    };
  }

  /**
   * Commands that wait for an answer until the test gives one, oldest first. Use a paused status with
   * them when the test watches a press: a poll would answer with the state from before it, and a
   * paused player's next poll is 15 s away instead of 5.
   */
  function heldCommands() {
    const answers: Array<(answer: MockResponse) => void> = [];
    return { answers, mock: () => new Promise<MockResponse>((resolve) => answers.push(resolve)) };
  }

  /** From here on the clock moves only when told to, however busy the machine is. */
  function takeOverTheClock() {
    vi.useFakeTimers({ shouldClearNativeTimers: true });
    return (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
  }

  it('pauses at once, before Spotify answers', async () => {
    const { user, requestsTo } = renderWidget(spotify());
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
    const { user, requestsTo } = renderWidget(spotify());
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

  it('sends one command at a time, in the order pressed', async () => {
    const held = heldCommands();
    const { user, requestsTo } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), 'POST /api/music/command': held.mock });
    await user.click(await screen.findByRole('button', { name: 'Repeat is off' }));
    await user.click(await screen.findByRole('button', { name: 'Repeating all' }));
    // The second press shows at once, though its request waits for Spotify's answer to the first.
    await screen.findByRole('button', { name: 'Repeating this track' });
    expect(sent(requestsTo('POST /api/music/command'))).toEqual([{ type: 'repeat', mode: 'context' }]);
    held.answers.shift()?.(mockResponse(204));
    await waitFor(() =>
      expect(sent(requestsTo('POST /api/music/command'))).toEqual([
        { type: 'repeat', mode: 'context' },
        { type: 'repeat', mode: 'track' },
      ]),
    );
  });

  it('reads the state back after the last press, so an earlier read cannot undo it', async () => {
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status(), ...accept });
    const reads = () => requestsTo('GET /api/music/status').length;
    const first = await screen.findByRole('button', { name: 'Repeat is off' });
    const pass = takeOverTheClock();
    fireEvent.click(first);
    await pass(MUSIC_SETTLE_MS - 100);
    fireEvent.click(screen.getByRole('button', { name: 'Repeating all' }));
    await pass(10);
    const before = reads();
    // The first press's read would land here, before Spotify has applied the second press.
    await pass(200);
    expect(reads()).toBe(before);
    expect(screen.getByRole('button', { name: 'Repeating this track' })).toBeInTheDocument();
    await pass(MUSIC_SETTLE_MS);
    expect(reads()).toBeGreaterThan(before);
    expect(sent(requestsTo('POST /api/music/command'))).toEqual([
      { type: 'repeat', mode: 'context' },
      { type: 'repeat', mode: 'track' },
    ]);
  });

  it('holds the read back while a later command has no answer yet', async () => {
    const held = heldCommands();
    const { requestsTo } = renderWidget({ 'GET /api/music/status': status(), 'POST /api/music/command': held.mock });
    const reads = () => requestsTo('GET /api/music/status').length;
    const first = await screen.findByRole('button', { name: 'Repeat is off' });
    const pass = takeOverTheClock();
    fireEvent.click(first);
    await pass(10);
    held.answers.shift()?.(mockResponse(204));
    await pass(10);
    fireEvent.click(screen.getByRole('button', { name: 'Repeating all' }));
    await pass(10);
    const before = reads();
    await pass(MUSIC_SETTLE_MS + 100);
    expect(reads()).toBe(before);
    expect(screen.getByRole('button', { name: 'Repeating this track' })).toBeInTheDocument();
    held.answers.shift()?.(mockResponse(204));
    await pass(MUSIC_SETTLE_MS + 100);
    expect(reads()).toBeGreaterThan(before);
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

  it('keeps a later press on screen when an earlier one is refused', async () => {
    const held = heldCommands();
    const { user } = renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), 'POST /api/music/command': held.mock });
    await user.click(await screen.findByRole('button', { name: 'Shuffle is off' }));
    await user.click(await screen.findByRole('button', { name: 'Repeat is off' }));
    await screen.findByRole('button', { name: 'Repeating all' });
    held.answers.shift()?.(mockError(403, 'forbidden', 'Spotify refused the shuffle'));
    expect(await screen.findByText('Spotify refused the shuffle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repeating all' })).toBeInTheDocument();
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
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    // Unanswered, so no read comes back to replace the position this test looks at.
    const { user, queryClient } = renderWidget({ 'GET /api/music/status': status({ positionMs: 30_000 }), 'POST /api/music/command': heldCommands().mock });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    expect(slider).toHaveValue('30');
    // Twelve seconds into playing, between two polls.
    clock.mockReturnValue(start + 12_000);
    await user.click(screen.getByRole('button', { name: 'Shuffle is off' }));
    await screen.findByRole('button', { name: 'Shuffle is on' });
    expect(queryClient.getQueryData<MusicStatus>(qk.music.status(null))?.playback?.positionMs).toBe(42_000);
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

describe('music widget: the phone', () => {
  const TITLE = 'Episode 12: The Lighthouse Keeper';
  const CREDIT = 'Pocket Casts, on your phone';
  const NO_ACCOUNT = mockError(409, 'not_configured', 'Connect a music service', { details: { reason: 'no_account' } });
  const report = (overrides: Partial<PhonePlayback> = {}): PhonePlayback => ({
    app: 'pocket-casts',
    state: 'playing',
    title: TITLE,
    show: 'Tales of the Harbour',
    durationMs: 1_800_000,
    positionMs: 60_000,
    speed: 1,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    ...overrides,
  });

  it('shows an episode with no music service connected, instead of asking to connect one', async () => {
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report() });
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText('Tales of the Harbour')).toBeInTheDocument();
    expect(screen.getByText(CREDIT)).toBeInTheDocument();
    expect(screen.queryByText('No music service connected')).not.toBeInTheDocument();
  });

  it('offers no control over it, no link and no Spotify logo', async () => {
    const { container } = renderWidget({ 'GET /api/music/status': status(null), 'GET /api/music/phone': report() });
    await screen.findByText(TITLE);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Position' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Position' })).toHaveAttribute('aria-valuetext', '1:00 / 30:00');
    expect(container.querySelector('img')).toBeNull();
  });

  it('says when it is paused, since no button shows that', async () => {
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report({ state: 'paused' }) });
    expect(await screen.findByText(`Paused · ${CREDIT}`)).toBeInTheDocument();
  });

  it('moves the bar on at the speed the phone plays', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report({ speed: 1.5 }) });
    const slider = await screen.findByRole('slider', { name: 'Position' });
    expect(slider).toHaveValue('60');
    clock.mockReturnValue(start + 10_000);
    await waitFor(() => expect(slider).toHaveValue('75'));
  });

  it('shows no bar when the length is unknown, or at the smallest size', async () => {
    const { unmount } = renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report({ durationMs: null }) });
    await screen.findByText(TITLE);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    unmount();
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report() }, { size: { w: 3, h: 3 } });
    expect(await screen.findByText(CREDIT)).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('copes with a show the app does not name', async () => {
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report({ show: null }) });
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(CREDIT)).toBeInTheDocument();
  });

  it('shows a title from a feed as plain text', async () => {
    const title = '<img src=x onerror=alert(1)>';
    const { container } = renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': report({ title }) });
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('gives way to Spotify when Spotify is playing and the phone is paused', async () => {
    renderWidget({ 'GET /api/music/status': status(), 'GET /api/music/phone': report({ state: 'paused' }) });
    expect(await screen.findByRole('link', { name: 'Harbor Lights at Dawn' })).toBeInTheDocument();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('shows over a paused Spotify, with the phone’s own look', async () => {
    renderWidget({ 'GET /api/music/status': status({ isPlaying: false }), 'GET /api/music/phone': report() });
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).not.toBeInTheDocument();
  });

  it('shows the one that started last when both are playing', async () => {
    const { unmount } = renderWidget({ 'GET /api/music/status': status({ positionMs: 30_000 }), 'GET /api/music/phone': report() });
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    unmount();
    const started = new Date(Date.now() - 120_000).toISOString();
    renderWidget({ 'GET /api/music/status': status({ positionMs: 30_000 }), 'GET /api/music/phone': report({ startedAt: started }) });
    expect(await screen.findByRole('link', { name: 'Harbor Lights at Dawn' })).toBeInTheDocument();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('shows an episode while Spotify needs reconnecting, and asks again once it ends', async () => {
    const account = { id: 'a1', kind: 'spotify', label: 'Sam', status: 'reauth' } as Account;
    const { queryClient } = renderWidget({ 'GET /api/accounts': [account], 'GET /api/music/status': mockError(409, 'reauth_required', 'Reconnect', { accountId: 'a1' }), 'GET /api/music/phone': report() });
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    act(() => void queryClient.setQueryData(qk.music.phone(), null));
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('goes back to the idle state when the report ends', async () => {
    const { queryClient } = renderWidget({ 'GET /api/music/status': status(null), 'GET /api/music/devices': [], 'GET /api/music/phone': report() });
    await screen.findByText(TITLE);
    act(() => void queryClient.setQueryData(qk.music.phone(), null));
    expect(await screen.findByText('Nothing is playing')).toBeInTheDocument();
  });

  it('holds the connect card back until the phone has answered', async () => {
    let answer: (value: MockResponse) => void = () => {};
    renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': () => new Promise<MockResponse>((resolve) => (answer = resolve)) });
    await waitFor(() => expect(answer).not.toBe(undefined));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText('No music service connected')).not.toBeInTheDocument();
    act(() => answer(mockResponse(200, null)));
    expect(await screen.findByText('No music service connected')).toBeInTheDocument();
  });

  it('leaves Spotify alone when the server is older and refuses the question', async () => {
    renderWidget({ 'GET /api/music/status': status(), 'GET /api/music/phone': mockError(404, 'not_found', 'Not found') });
    expect(await screen.findByRole('link', { name: 'Harbor Lights at Dawn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
  });

  it('keeps showing the last report, marked stale, when a refresh fails', async () => {
    const answers: ApiMock[] = [report(), mockError(502, 'internal', 'The server is gone')];
    const { queryClient } = renderWidget({ 'GET /api/music/status': NO_ACCOUNT, 'GET /api/music/phone': () => answers.shift() ?? mockError(502, 'internal', 'The server is gone') });
    await screen.findByText(TITLE);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: qk.music.phone() });
    });
    expect(await within(screen.getByTestId('actions')).findByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByText(TITLE)).toBeInTheDocument();
  });
});

describe('music widget: privacy', () => {
  it('never writes what is playing to the persisted cache', async () => {
    const { queryClient } = renderWidget({ 'GET /api/music/status': status(), 'GET /api/music/devices': [DEVICE] });
    await screen.findByRole('link', { name: 'Harbor Lights at Dawn' });
    const query = queryClient.getQueryCache().find({ queryKey: qk.music.status(null) });
    expect(query).toBeDefined();
    expect(shouldPersistQuery(query!)).toBe(false);
    const phone = queryClient.getQueryCache().find({ queryKey: qk.music.phone() });
    expect(phone).toBeDefined();
    expect(shouldPersistQuery(phone!)).toBe(false);
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
