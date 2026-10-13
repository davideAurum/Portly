import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@homebase/shared';
import { settings as makeSettings } from '../../test/fixtures.ts';
import { renderWithProviders } from '../../test/render.tsx';
import {
  clockTier,
  defaultZoneLabel,
  describeOffsetDiff,
  effectiveTimeFormat,
  formatOffsetDiff,
  greetingText,
  listTimeZones,
  offsetLabel,
  partOfDay,
  relativeDay,
  searchTimeZones,
  timeParts,
  zoneDayDiff,
  zoneOffsetMinutes,
  zoneOptions,
} from './clock.ts';
import { clockConfigSchema, type ClockConfig } from './index.ts';
import ClockSettings from './Settings.tsx';
import ClockWidget from './Widget.tsx';

/** 14:05:09 local time on Saturday 26 September 2026 (local constructor: TZ-independent fields). */
const AFTERNOON = new Date(2026, 8, 26, 14, 5, 9);
const SUMMER_UTC = new Date('2026-07-01T12:00:00Z');

function settingsWith(general: Partial<Settings['general']> = {}): Settings {
  const base = makeSettings();
  return { ...base, general: { ...base.general, locale: 'en-US', ...general } };
}

function renderClock(config: Partial<ClockConfig> = {}, { size = { w: 4, h: 3 }, settings = settingsWith() } = {}) {
  return renderWithProviders(
    <ClockWidget instanceId="w-clock" config={clockConfigSchema.parse(config)} setConfig={vi.fn(async () => {})} size={size} editMode={false} />,
    { apiMocks: { 'GET /api/settings': settings } },
  );
}

async function clockText(): Promise<string> {
  return (await screen.findByTestId('clock-time')).textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: AFTERNOON });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('clock formatting', () => {
  it('resolves the effective time format (inherit → settings → locale)', () => {
    expect(effectiveTimeFormat('inherit', '24h')).toBe('24h');
    expect(effectiveTimeFormat('inherit', undefined)).toBe('system');
    expect(effectiveTimeFormat('12h', '24h')).toBe('12h');
  });

  it('splits the time into digits and day period, respecting locale and hour cycle', () => {
    expect(timeParts(AFTERNOON, { locale: 'en-US', timeFormat: '12h' })).toMatchObject({ main: '2:05', dayPeriod: 'PM', dayPeriodFirst: false });
    expect(timeParts(AFTERNOON, { locale: 'en-US', timeFormat: '24h' })).toMatchObject({ main: '14:05', dayPeriod: null });
    expect(timeParts(AFTERNOON, { locale: 'en-US', timeFormat: '12h', seconds: true }).main).toBe('2:05:09');
    // 'system' follows the locale: US English is 12-hour, German 24-hour.
    expect(timeParts(AFTERNOON, { locale: 'en-US', timeFormat: 'system' }).dayPeriod).toBe('PM');
    expect(timeParts(AFTERNOON, { locale: 'de-DE', timeFormat: 'system' })).toMatchObject({ main: '14:05', dayPeriod: null });
    // Korean puts the day period first.
    expect(timeParts(AFTERNOON, { locale: 'ko-KR', timeFormat: '12h' }).dayPeriodFirst).toBe(true);
    // Other zones.
    expect(timeParts(SUMMER_UTC, { locale: 'en-US', timeFormat: '24h', timeZone: 'Asia/Tokyo' }).main).toBe('21:00');
  });

  it('greets by local time of day, with the user name when set', () => {
    expect(partOfDay(0)).toBe('night');
    expect(partOfDay(4)).toBe('night');
    // Not "Good evening" at 2:15 AM (UX-7).
    expect(greetingText(new Date(2026, 8, 26, 2, 15), 'Dana')).toBe('Hello, Dana');
    expect(partOfDay(23)).toBe('evening');
    expect(partOfDay(5)).toBe('morning');
    expect(partOfDay(11)).toBe('morning');
    expect(partOfDay(12)).toBe('afternoon');
    expect(partOfDay(17)).toBe('afternoon');
    expect(partOfDay(18)).toBe('evening');
    expect(greetingText(new Date(2026, 8, 26, 8, 30), 'Dana')).toBe('Good morning, Dana');
    expect(greetingText(new Date(2026, 8, 26, 20, 0), '  ')).toBe('Good evening');
    expect(greetingText(AFTERNOON)).toBe('Good afternoon');
  });

  it('computes zone offsets and day differences', () => {
    expect(zoneOffsetMinutes('Asia/Tokyo', SUMMER_UTC)).toBe(540);
    expect(zoneOffsetMinutes('Asia/Kolkata', SUMMER_UTC)).toBe(330);
    expect(zoneOffsetMinutes('America/New_York', SUMMER_UTC)).toBe(-240);
    expect(zoneOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(zoneOffsetMinutes('UTC', SUMMER_UTC)).toBe(0);
    // 20:00 UTC: already tomorrow in Tokyo, still today in New York.
    const evening = new Date('2026-07-01T20:00:00Z');
    expect(zoneDayDiff('Asia/Tokyo', 'Europe/London', evening)).toBe(1);
    expect(zoneDayDiff('America/Los_Angeles', 'Asia/Tokyo', evening)).toBe(-1);
    expect(zoneDayDiff('Europe/Paris', 'Europe/Berlin', evening)).toBe(0);
  });

  it('formats offsets and relative days', () => {
    expect(formatOffsetDiff(0)).toBe('Same time');
    expect(formatOffsetDiff(540)).toBe('+9h');
    expect(formatOffsetDiff(-210)).toBe('−3h 30m');
    expect(formatOffsetDiff(45)).toBe('+45m');
    expect(describeOffsetDiff(-60)).toBe('1 hour behind');
    expect(describeOffsetDiff(330)).toBe('5 hours 30 minutes ahead');
    expect(offsetLabel(330)).toBe('UTC+5:30');
    expect(offsetLabel(-300)).toBe('UTC−5');
    expect(offsetLabel(0)).toBe('UTC');
    expect(relativeDay(1, 'en-US')).toBe('Tomorrow');
    expect(relativeDay(-1, 'en-US')).toBe('Yesterday');
    expect(relativeDay(0, 'en-US')).toBe('Today');
  });

  it('lists and searches IANA zones by city, region or UTC offset', () => {
    const zones = listTimeZones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Tokyo');
    expect(zones.length).toBeGreaterThan(300);
    const options = zoneOptions(zones, SUMMER_UTC);
    expect(searchTimeZones(options, 'tokyo').map((o) => o.tz)).toEqual(['Asia/Tokyo']);
    expect(searchTimeZones(options, 'new york')[0]!.tz).toBe('America/New_York');
    expect(searchTimeZones(options, 'buenos_aires')[0]!.tz).toBe('America/Argentina/Buenos_Aires');
    expect(searchTimeZones(options, 'utc+9').map((o) => o.tz)).toContain('Asia/Tokyo');
    expect(searchTimeZones(options, 'utc+5:30').map((o) => o.tz)).toContain('Asia/Kolkata');
    // Browsers list some legacy CLDR ids; the modern IANA names are offered and both are searchable.
    expect(zones).not.toContain('Asia/Calcutta');
    expect(searchTimeZones(options, 'kolkata').map((o) => o.tz)).toEqual(['Asia/Kolkata']);
    expect(searchTimeZones(options, 'calcutta').map((o) => o.tz)).toEqual(['Asia/Kolkata']);
    expect(searchTimeZones(options, 'kyiv').map((o) => o.tz)).toEqual(['Europe/Kyiv']);
    expect(new Set(zones).size).toBe(zones.length);
    expect(searchTimeZones(options, '   ')).toEqual([]);
    expect(defaultZoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(defaultZoneLabel('UTC')).toBe('UTC');
  });

  it('chooses the tier from the grid size', () => {
    expect(clockTier({ w: 2, h: 2 })).toBe('compact');
    expect(clockTier({ w: 4, h: 3 })).toBe('medium');
    expect(clockTier({ w: 3, h: 6 })).toBe('medium');
    expect(clockTier({ w: 6, h: 5 })).toBe('large');
  });

  it('drops invalid extra zones individually instead of resetting the config', () => {
    const parsed = clockConfigSchema.parse({
      format: '24h',
      extraZones: [
        { label: 'Tokyo', tz: 'Asia/Tokyo' },
        { label: 'Nowhere', tz: 'Mars/Olympus_Mons' },
        { label: '', tz: 'Europe/Paris' },
        { label: 'NYC', tz: 'America/New_York' },
      ],
    });
    expect(parsed.format).toBe('24h');
    expect(parsed.extraZones).toEqual([
      { label: 'Tokyo', tz: 'Asia/Tokyo' },
      { label: 'NYC', tz: 'America/New_York' },
    ]);
    expect(clockConfigSchema.parse({ extraZones: 'nope' as unknown as [] }).extraZones).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

describe('clock widget', () => {
  it('inherits the time format from settings and shows the date', async () => {
    renderClock({}, { settings: settingsWith({ timeFormat: '24h' }) });
    expect(await screen.findByText('Good afternoon')).toBeInTheDocument();
    expect(await clockText()).toBe('14:05');
    expect(screen.getByText('Saturday, September 26')).toBeInTheDocument();
    expect(screen.getByRole('time')).toHaveAttribute('datetime', AFTERNOON.toISOString());
  });

  it('uses the widget format override, the locale and optional seconds', async () => {
    renderClock({ format: '12h', showSeconds: true, showDate: false }, { settings: settingsWith({ timeFormat: '24h' }) });
    expect(await clockText()).toBe('2:05:09PM');
    expect(screen.getByText('2:05:09 PM')).toHaveClass('hb-visually-hidden');
    expect(screen.queryByText('Saturday, September 26')).toBeNull();
  });

  it('respects the settings locale ("system" time format → locale default)', async () => {
    renderClock({}, { settings: settingsWith({ locale: 'de-DE', timeFormat: 'system' }) });
    expect(await screen.findByText('Samstag, 26. September')).toBeInTheDocument();
    expect(await clockText()).toBe('14:05');
  });

  it('greets the user by name and updates with the time of day', async () => {
    vi.setSystemTime(new Date(2026, 8, 26, 8, 59, 30));
    renderClock({}, { settings: settingsWith({ userName: 'Dana' }) });
    expect(await screen.findByText('Good morning, Dana')).toBeInTheDocument();
  });

  it('hides the greeting when turned off', async () => {
    renderClock({ greeting: false }, { settings: settingsWith({ userName: 'Dana' }) });
    expect(await screen.findByText('Saturday, September 26')).toBeInTheDocument();
    expect(screen.queryByText(/Good /)).toBeNull();
  });

  it('ticks every second when seconds are shown', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: AFTERNOON });
    renderClock({ format: '24h', showSeconds: true });
    expect(screen.getByTestId('clock-time')).toHaveTextContent('14:05:09');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('clock-time')).toHaveTextContent('14:05:10');
    vi.useRealTimers();
  });

  it('compact size shows only the time (and date)', async () => {
    const { container } = renderClock(
      { format: '24h', extraZones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }] },
      { size: { w: 2, h: 2 }, settings: settingsWith({ userName: 'Dana' }) },
    );
    expect(await clockText()).toBe('14:05');
    expect(container.querySelector('[data-tier="compact"]')).not.toBeNull();
    expect(screen.queryByRole('list', { name: 'Other time zones' })).toBeNull();
    expect(screen.queryByText(/Good afternoon/)).toBeNull();
  });

  it('medium size shows extra zones as chips; large size as a list with day and offset', async () => {
    const zones = [
      { label: 'Tokyo', tz: 'Asia/Tokyo' },
      { label: 'Home', tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    ];
    const tokyo = timeParts(AFTERNOON, { locale: 'en-US', timeFormat: '24h', timeZone: 'Asia/Tokyo' }).text;

    const medium = renderClock({ format: '24h', extraZones: zones });
    const chips = await screen.findByRole('list', { name: 'Other time zones' });
    expect(chips).toHaveAttribute('data-layout', 'chips');
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getByText(new RegExp(`^Tokyo: ${tokyo}`))).toBeInTheDocument();
    expect(within(chips).getByText('Home: 14:05, today, same time')).toBeInTheDocument();
    medium.unmount();

    renderClock({ format: '24h', extraZones: zones }, { size: { w: 6, h: 6 } });
    const list = await screen.findByRole('list', { name: 'Other time zones' });
    expect(list).toHaveAttribute('data-layout', 'list');
    expect(within(list).getByText('Today · Same time')).toBeInTheDocument();
    expect(within(list).getByText('Tokyo')).toBeInTheDocument();
  });
});

describe('clock: chips that do not fit (UX-7)', () => {
  it('sums up the zones that would wrap out of sight as a "+N" chip naming them', async () => {
    // Simulated layout: a row holds two items; the third item (and later) wraps.
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      if (!parent || parent.getAttribute('aria-label') !== 'Other time zones') return 0;
      return [...parent.children].indexOf(this) >= 2 ? 28 : 0;
    });
    try {
      const zones = [
        { label: 'Tokyo', tz: 'Asia/Tokyo' },
        { label: 'London', tz: 'Europe/London' },
        { label: 'Los Angeles', tz: 'America/Los_Angeles' },
      ];
      renderClock({ format: '24h', extraZones: zones });
      const chips = await screen.findByRole('list', { name: 'Other time zones' });
      await waitFor(() => expect(within(chips).getAllByRole('listitem')).toHaveLength(2));
      const more = within(chips).getByText('+2').closest('li')!;
      expect(more).toHaveAttribute('title', 'London, Los Angeles');
      expect(within(chips).getByText('2 more: London, Los Angeles')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings(value: Partial<ClockConfig> = {}, settings = settingsWith({ timeFormat: '24h' })) {
  const onChange = vi.fn();
  const result = renderWithProviders(<ClockSettings value={clockConfigSchema.parse(value)} onChange={onChange} />, {
    apiMocks: { 'GET /api/settings': settings },
  });
  return { ...result, onChange, user: userEvent.setup() };
}

describe('clock settings', () => {
  it('changes format and toggles', async () => {
    const { user, onChange } = renderSettings();
    expect(await screen.findByRole('radio', { name: 'Default (24-hour)' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: '12-hour' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ format: '12h' }));
    await user.click(screen.getByRole('switch', { name: 'Show seconds' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ showSeconds: true }));
    await user.click(screen.getByRole('switch', { name: 'Show greeting' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ greeting: false }));
    expect(screen.getByRole('link', { name: 'General settings' })).toHaveAttribute('href', '#/settings/general');
  });

  it('adds a zone from the searchable list with a default label (keyboard)', async () => {
    const { user, onChange } = renderSettings();
    const picker = screen.getByRole('combobox', { name: 'Add a time zone' });
    await user.type(picker, 'tokyo');
    const option = await screen.findByRole('option', { name: /Asia\/Tokyo, UTC\+9/ });
    expect(option).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extraZones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }] }));
    expect(picker).toHaveValue('');
  });

  it('edits labels (never saving an empty one), reorders and removes zones', async () => {
    const zones = [
      { label: 'Tokyo', tz: 'Asia/Tokyo' },
      { label: 'NYC', tz: 'America/New_York' },
    ];
    const { user, onChange } = renderSettings({ extraZones: zones });
    const label = await screen.findByRole('textbox', { name: 'Label for Asia/Tokyo' });
    await user.clear(label);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extraZones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }, zones[1]] }));
    await user.type(label, 'Office');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extraZones: [{ label: 'Office', tz: 'Asia/Tokyo' }, zones[1]] }));

    await user.click(screen.getByRole('button', { name: 'Move NYC up' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extraZones: [zones[1], zones[0]] }));
    await user.click(screen.getByRole('button', { name: 'Remove NYC' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ extraZones: [zones[0]] }));
    expect(screen.getByRole('button', { name: 'Move Tokyo up' })).toBeDisabled();
  });

  it('excludes zones already added and stops at six', async () => {
    const six = ['Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'UTC'].map((tz) => ({ label: defaultZoneLabel(tz), tz }));
    renderSettings({ extraZones: six });
    expect(await screen.findByRole('combobox', { name: 'Add a time zone' })).toBeDisabled();
    expect(screen.getByText('Up to 6 time zones. Remove one to add another.')).toBeInTheDocument();
  });

  it('does not offer a zone twice', async () => {
    const { user } = renderSettings({ extraZones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }] });
    await user.type(await screen.findByRole('combobox', { name: 'Add a time zone' }), 'tokyo');
    expect(await screen.findByText('No time zones match “tokyo”.')).toBeInTheDocument();
  });
});
