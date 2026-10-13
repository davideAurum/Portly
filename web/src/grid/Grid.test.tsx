import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutItem } from 'react-grid-layout';
import { Shell } from '../app/Shell.tsx';
import { createFakeServer } from '../test/fakeServer.ts';
import { profile, shellMocks, widget } from '../test/fixtures.ts';
import { mockResponse, renderWithProviders } from '../test/render.tsx';
import type { ClockConfig } from '../widgets/clock/index.ts';
import { getWidgetDefinition } from '../widgets/registry.ts';
import type { WidgetProps } from '../widgets/types.ts';

interface FakeGridProps {
  layout: LayoutItem[];
  children: ReactNode;
  onLayoutChange?: (layout: LayoutItem[]) => void;
  dragConfig?: { enabled?: boolean; handle?: string; cancel?: string };
  resizeConfig?: { enabled?: boolean; handles?: readonly string[] };
  gridConfig?: unknown;
}

// react-grid-layout needs real layout measurements; the fake records its props so tests can
// drive onLayoutChange directly (that is exactly what a drag/resize ends with).
const rgl = vi.hoisted(() => ({ props: null as FakeGridProps | null }));

vi.mock('react-grid-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-grid-layout')>();
  function FakeGridLayout(props: FakeGridProps) {
    rgl.props = props;
    return <div data-testid="rgl">{props.children}</div>;
  }
  return {
    ...actual,
    default: FakeGridLayout,
    useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

// Real definitions with stand-in widgets (see stubWidgets.tsx), plus a clock that exercises setConfig.
vi.mock('../widgets/registry.ts', async (importOriginal) => {
  const { stubWidgetRegistry } = await import('../test/stubWidgets.tsx');
  function ClockWithSetConfig({ config, setConfig }: WidgetProps<ClockConfig>) {
    return (
      <button type="button" onClick={() => void setConfig({ showSeconds: !config.showSeconds })}>
        {config.showSeconds ? 'seconds on' : 'seconds off'}
      </button>
    );
  }
  return stubWidgetRegistry(await importOriginal(), { components: { clock: ClockWithSetConfig } });
});

const home = profile('p1', 'Home', [
  widget('w-clock', 'clock', 0, 0, 4, 3),
  widget('w-weather', 'weather', 4, 0, 4, 5),
]);

const clockSize = () => getWidgetDefinition('clock')!.defaultSize;
const defaultConfig = (type: string): Record<string, unknown> => getWidgetDefinition(type)!.configSchema.parse({}) as Record<string, unknown>;

function layoutChange(items: { i: string; x: number; y: number; w: number; h: number }[]) {
  act(() => rgl.props?.onLayoutChange?.(items));
}

async function renderDashboard(extraMocks: Record<string, unknown> = {}) {
  const server = createFakeServer([home]);
  const result = renderWithProviders(<Shell />, { apiMocks: { ...server.mocks, ...extraMocks } });
  await screen.findByRole('button', { name: 'seconds off' });
  return { ...result, server };
}

async function enterEditMode() {
  const toggle = screen.getByRole('button', { name: 'Edit layout' });
  await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

describe('Grid', () => {
  beforeEach(() => {
    rgl.props = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('configures react-grid-layout per §10.2 and enables drag/resize only in edit mode', async () => {
    await renderDashboard();
    expect(rgl.props?.gridConfig).toEqual({ cols: 12, rowHeight: 40, margin: [12, 12] });
    expect(rgl.props?.dragConfig).toEqual({ enabled: false, handle: '.hb-drag-handle', cancel: 'input,textarea,select,button,a,[data-no-grid-drag]' });
    expect(rgl.props?.resizeConfig).toEqual({ enabled: false, handles: ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'] });
    expect(rgl.props?.layout).toEqual([
      expect.objectContaining({ i: 'w-clock', x: 0, y: 0, w: 4, h: 3, minW: clockSize().minW, minH: clockSize().minH }),
      expect.objectContaining({ i: 'w-weather', x: 4, y: 0, w: 4, h: 5 }),
    ]);

    await enterEditMode();
    expect(rgl.props?.dragConfig).toMatchObject({ enabled: true });
    expect(rgl.props?.resizeConfig).toMatchObject({ enabled: true });
    // Every frame gets a drag handle header and a keyboard-operable grip.
    expect(document.querySelectorAll('.hb-drag-handle')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Move Weather' })).toBeInTheDocument();
  });

  it('marks <html> while edit mode is on, so a backend switch waits for the user to finish', async () => {
    const { unmount } = await renderDashboard();
    expect(document.documentElement.dataset.portlyEditing).toBeUndefined();
    await enterEditMode();
    expect(document.documentElement.dataset.portlyEditing).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.documentElement.dataset.portlyEditing).toBeUndefined();
    expect(document.documentElement.hasAttribute('data-portly-editing')).toBe(false);

    await enterEditMode();
    expect(document.documentElement.dataset.portlyEditing).toBe('true');
    // Leaving the dashboard (unmounting the provider) clears it too.
    unmount();
    expect(document.documentElement.hasAttribute('data-portly-editing')).toBe(false);
  });

  it('saves changed positions with one debounced PUT /positions (never PATCH) in edit mode', async () => {
    const { requestsTo, requests } = await renderDashboard();
    await enterEditMode();

    layoutChange([
      { i: 'w-clock', x: 4, y: 0, w: 4, h: 3 },
      { i: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
    ]);
    layoutChange([
      { i: 'w-clock', x: 4, y: 0, w: 6, h: 3 },
      { i: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
    ]);
    // Optimistic: the grid shows the new layout before anything is saved.
    await waitFor(() => expect(rgl.props?.layout).toEqual(expect.arrayContaining([expect.objectContaining({ i: 'w-clock', x: 4, w: 6 })])));
    expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(0);

    await waitFor(() => expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(1));
    expect(requestsTo('PUT /api/profiles/p1/positions')[0]!.body).toEqual({
      items: [
        { id: 'w-clock', x: 4, y: 0, w: 6, h: 3 },
        { id: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
      ],
    });
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('flushes pending positions immediately when edit mode ends', async () => {
    const { requestsTo } = await renderDashboard();
    await enterEditMode();
    layoutChange([
      { i: 'w-clock', x: 0, y: 5, w: 4, h: 3 },
      { i: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(1);
  });

  it('saves pending positions before switching to another profile', async () => {
    const user = userEvent.setup();
    const server = createFakeServer([home, profile('p2', 'Work', [widget('w-mail', 'mail', 0, 2, 4, 4)], 1)]);
    const { requestsTo } = renderWithProviders(<Shell />, { apiMocks: server.mocks });
    await screen.findByRole('button', { name: 'seconds off' });
    await enterEditMode();

    layoutChange([
      { i: 'w-clock', x: 8, y: 0, w: 4, h: 3 },
      { i: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
    ]);
    await user.click(screen.getByRole('button', { name: /Profile: Home/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Work' }));
    await screen.findByRole('region', { name: 'Mail' });
    // Work's stored layout had a gap; the grid compacts it within Home's debounce window.
    layoutChange([{ i: 'w-mail', x: 0, y: 0, w: 4, h: 4 }]);

    await waitFor(() => expect(requestsTo('PUT /api/profiles/p2/positions')).toHaveLength(1));
    expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(1);
    expect(server.profiles[0]!.layout.items.find((i) => i.id === 'w-clock')).toMatchObject({ x: 8, y: 0 });
    expect(server.profiles[1]!.layout.items[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('keeps a moved widget in place when an older profiles refetch lands afterwards', async () => {
    let release!: () => void;
    let gated = false;
    const server = createFakeServer([home]);
    const list = server.mocks['GET /api/profiles'] as () => unknown;
    const { queryClient } = renderWithProviders(<Shell />, {
      apiMocks: {
        ...server.mocks,
        'GET /api/profiles': async () => {
          const snapshot = list();
          if (gated) await new Promise<void>((resolve) => (release = resolve));
          return snapshot;
        },
      },
    });
    await screen.findByRole('button', { name: 'seconds off' });
    await enterEditMode();

    gated = true;
    void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    layoutChange([
      { i: 'w-clock', x: 8, y: 0, w: 4, h: 3 },
      { i: 'w-weather', x: 0, y: 0, w: 4, h: 5 },
    ]);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(rgl.props?.layout).toEqual(expect.arrayContaining([expect.objectContaining({ i: 'w-clock', x: 8 })]));
  });

  it('never saves layout changes outside edit mode (e.g. compaction on load)', async () => {
    const { requestsTo } = await renderDashboard();
    layoutChange([
      { i: 'w-clock', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w-weather', x: 4, y: 3, w: 4, h: 5 },
    ]);
    await new Promise((r) => setTimeout(r, 700));
    expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(0);
  });

  it('does not save when the layout did not actually change', async () => {
    const { requestsTo } = await renderDashboard();
    await enterEditMode();
    layoutChange([
      { i: 'w-clock', x: 0, y: 0, w: 4, h: 3 },
      { i: 'w-weather', x: 4, y: 0, w: 4, h: 5 },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(requestsTo('PUT /api/profiles/p1/positions')).toHaveLength(0);
  });

  it('setConfig PATCHes only that widget config (merged, validated), never positions', async () => {
    const { requestsTo, requests } = await renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'seconds off' }));
    // Optimistic update.
    expect(await screen.findByRole('button', { name: 'seconds on' })).toBeInTheDocument();
    await waitFor(() => expect(requestsTo('PATCH /api/profiles/p1/widgets/w-clock')).toHaveLength(1));
    expect(requestsTo('PATCH /api/profiles/p1/widgets/w-clock')[0]!.body).toEqual({
      config: { ...defaultConfig('clock'), showSeconds: true },
    });
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('rolls back an optimistic config change the server rejects', async () => {
    await renderDashboard({
      'PATCH /api/profiles/p1/widgets/w-clock': mockResponse(422, { error: { code: 'validation_failed', message: 'Nope' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'seconds off' }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'seconds off' })).toBeInTheDocument();
  });

  it('moves and resizes with the keyboard from the grip', async () => {
    const { requestsTo } = await renderDashboard();
    await enterEditMode();
    const grip = screen.getByRole('button', { name: 'Move Clock' });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowDown', shiftKey: true });
    expect(await screen.findByText('Clock resized to 4 columns by 4 rows.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(requestsTo('PUT /api/profiles/p1/positions')[0]!.body).toEqual({
      items: [
        { id: 'w-clock', x: 0, y: 0, w: 4, h: 4 },
        { id: 'w-weather', x: 4, y: 0, w: 4, h: 5 },
      ],
    });
  });

  it('opens widget settings with a live preview and saves config + frame in one PATCH', async () => {
    const user = userEvent.setup();
    const { requestsTo } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: 'Weather settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Weather settings' });
    // Frame options plus the widget's own Settings component.
    expect(await within(dialog).findByText('Widget-specific settings')).toBeInTheDocument();

    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Berlin');
    // Live preview on the dashboard before saving (the modal hides the page from the a11y tree).
    expect(screen.getByRole('heading', { level: 2, name: 'Berlin', hidden: true })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('switch', { name: /Transparent background/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(requestsTo('PATCH /api/profiles/p1/widgets/w-weather')).toHaveLength(1);
    expect(requestsTo('PATCH /api/profiles/p1/widgets/w-weather')[0]!.body).toEqual({
      config: defaultConfig('weather'),
      frame: { title: 'Berlin', showHeader: true, transparent: true },
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Berlin' })).toBeInTheDocument();
  });

  it('discards the preview on cancel', async () => {
    const user = userEvent.setup();
    const { requestsTo } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: 'Weather settings' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Temp');
    expect(screen.getByRole('heading', { level: 2, name: 'Temp', hidden: true })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Temp' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Weather' })).toBeInTheDocument();
    expect(requestsTo('PATCH /api/profiles/p1/widgets/w-weather')).toHaveLength(0);
  });

  it('removes a widget only after confirmation', async () => {
    const user = userEvent.setup();
    const { requestsTo } = await renderDashboard();
    await enterEditMode();
    await user.click(screen.getByRole('button', { name: 'Remove Weather' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Weather?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(requestsTo('DELETE /api/profiles/p1/widgets/w-weather')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Remove Weather' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Remove Weather?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(requestsTo('DELETE /api/profiles/p1/widgets/w-weather')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Weather' })).not.toBeInTheDocument());
  });

  it('adds widgets from the registry (multiple instances allowed)', async () => {
    const user = userEvent.setup();
    const { requestsTo } = await renderDashboard();
    await enterEditMode();
    await user.click(within(screen.getByRole('region', { name: 'Edit mode' })).getByRole('button', { name: 'Add widget' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a widget' });
    expect(within(dialog).getAllByRole('button', { name: /Add (Search|Launch pad|Calendar|Mail|Todoist|Weather|Clock)$/ })).toHaveLength(7);
    await user.click(within(dialog).getByRole('button', { name: /Add Weather/ }));
    await waitFor(() => expect(requestsTo('POST /api/profiles/p1/widgets')).toHaveLength(1));
    expect(requestsTo('POST /api/profiles/p1/widgets')[0]!.body).toEqual({ type: 'weather' });
    expect(await screen.findByText('Weather added.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a widget' })).not.toBeInTheDocument());
    // The new one is scrolled to and briefly highlighted (UX-6).
    await waitFor(() => expect(document.querySelectorAll('[data-just-added="true"]')).toHaveLength(1));
    const added = document.querySelector<HTMLElement>('[data-just-added="true"]')!;
    expect(within(added).getByRole('region', { name: 'Weather' })).toBeInTheDocument();
  });

  it('stacks widgets full-width in (y, x) order below 768px and disables editing', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(max-width: 767px)',
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    renderWithProviders(<Shell />, {
      apiMocks: shellMocks([
        profile('p1', 'Home', [widget('b', 'weather', 4, 0, 4, 5), widget('c', 'mail', 0, 5, 4, 4), widget('a', 'calendar', 0, 0, 4, 5)]),
      ]),
    });
    const regions = await screen.findAllByRole('region', { name: /Weather|Mail|Calendar/ });
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual(['Calendar', 'Weather', 'Mail']);
    expect(screen.queryByTestId('rgl')).not.toBeInTheDocument();
    // Lists size to their content (UX-3); weather keeps its row height for its layout tier.
    const sizing = regions.map((r) => r.closest('[data-instance-id]')?.getAttribute('data-stack-sizing'));
    expect(sizing).toEqual(['content', 'fixed', 'content']);
    const toggle = screen.getByRole('button', { name: 'Edit layout' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-disabled', 'true'));
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // A tap shows why nothing happens (no hover tooltip on a phone), also for screen readers (UX-10).
    expect(toggle).toHaveAccessibleDescription('Editing needs a wider window');
    fireEvent.click(toggle);
    expect(await screen.findByText('Editing needs a wider window', { selector: '[data-sonner-toast] *' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});
