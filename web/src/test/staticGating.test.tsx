/**
 * Pages-build gating, read at render time from `getCapabilities()`. On the in-browser backend
 * (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`) server-only widgets disappear from
 * "Add widget" and the default layout but keep their titles when a persisted layout still has
 * them; server-only settings sections (Calendars) are hidden and answer with a notice, while
 * Accounts stays for Outlook.com, which signs in from the browser, and Diagnostics stays with this
 * site's overview and this browser's events (never asking a server). On the Homebase server
 * (hybrid mode, `capabilitiesFor(true, 'server')`) the same page load offers everything.
 */
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { createDefaultLayout } from '../grid/defaultLayout.ts';
import { WidgetFrame } from '../grid/WidgetFrame.tsx';
import { ALL_SETTINGS_SECTIONS, isSettingsSectionAvailable, settingsSections } from '../settings/nav.ts';
import { SettingsShell } from '../settings/SettingsShell.tsx';
import { WIDGET_DEFINITIONS, availableWidgetDefinitions, getWidgetDefinition, preloadWidgets } from '../widgets/registry.ts';
import { renderWithProviders } from './render.tsx';

const CALENDAR_INSTANCE = { id: 'w1', type: 'calendar', x: 0, y: 0, w: 4, h: 4, config: {}, frame: { showHeader: true, transparent: false } };

describe('static build gating (Pages build, in-browser backend)', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

  it('hides calendar, mail and feeds from the catalog and the default layout, but keeps the registry whole', () => {
    expect(WIDGET_DEFINITIONS.map((d) => d.type)).toContain('calendar');
    expect(WIDGET_DEFINITIONS.map((d) => d.type)).toContain('feeds');
    expect(availableWidgetDefinitions().map((d) => d.type)).toEqual(['search', 'launchpad', 'todoist', 'weather', 'sports', 'clock']);
    const types = createDefaultLayout().items.map((i) => i.type);
    expect(types).toEqual(['search', 'clock', 'launchpad', 'weather', 'todoist']);
  });

  it('hides the Calendars section but keeps Accounts (Outlook.com signs in from the browser)', () => {
    expect(ALL_SETTINGS_SECTIONS.map((s) => s.id)).toContain('calendars');
    expect(settingsSections().map((s) => s.id)).toEqual(['general', 'appearance', 'search', 'bookmarks', 'accounts', 'todoist', 'profiles', 'import-export', 'diagnostics', 'about']);
    expect(isSettingsSectionAvailable('accounts')).toBe(true);
    expect(isSettingsSectionAvailable('calendars')).toBe(false);
    expect(isSettingsSectionAvailable('general')).toBe(true);
    expect(isSettingsSectionAvailable('diagnostics')).toBe(true);
  });

  it('opens Diagnostics with this site’s overview and this browser’s events, without asking a server', async () => {
    const { requests } = renderWithProviders(<SettingsShell section="diagnostics" />);
    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'This browser']);
    expect(screen.getByRole('region', { name: 'This site' })).toBeInTheDocument();
    expect(screen.queryByText(/needs the Homebase server/)).not.toBeInTheDocument();
    expect(requests.filter((r) => r.path.startsWith('/api/diagnostics'))).toEqual([]);
  });

  it('renders a notice instead of a server-only widget that is still in a layout', async () => {
    renderWithProviders(<WidgetFrame instance={CALENDAR_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    expect(await screen.findByText('Calendar needs the Homebase server')).toBeInTheDocument();
    expect(screen.getByText(/Not available in the browser-only build/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Calendar settings/ })).not.toBeInTheDocument();
  });

  it('shows a notice when a hidden settings section is opened by URL', async () => {
    renderWithProviders(<SettingsShell section="calendars" />);
    expect(await screen.findByText('Calendars needs the Homebase server')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Calendars' })).not.toBeInTheDocument();
  });

  it('never preloads the code of widgets this page load cannot show', async () => {
    const preloads = Object.fromEntries(
      ['calendar', 'mail', 'clock'].map((type) => {
        const component = getWidgetDefinition(type)!.Component as { preload?: () => Promise<unknown> };
        return [type, vi.spyOn(component, 'preload').mockResolvedValue(undefined)];
      }),
    );
    await preloadWidgets(['calendar', 'mail', 'clock', 'clock'], 0);
    expect(preloads.calendar).not.toHaveBeenCalled();
    expect(preloads.mail).not.toHaveBeenCalled();
    expect(preloads.clock).toHaveBeenCalledTimes(1);
  });
});

describe('static build gating (Pages build on the Homebase server on this PC)', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('offers calendar, mail and feeds and the full default layout', () => {
    expect(availableWidgetDefinitions().map((d) => d.type)).toEqual(WIDGET_DEFINITIONS.map((d) => d.type));
    expect(createDefaultLayout().items.map((i) => i.type)).toEqual(['search', 'clock', 'launchpad', 'weather', 'calendar', 'todoist', 'mail']);
  });

  it('shows the Accounts and Calendars sections', () => {
    expect(settingsSections()).toEqual(ALL_SETTINGS_SECTIONS);
    expect(isSettingsSectionAvailable('accounts')).toBe(true);
    expect(isSettingsSectionAvailable('calendars')).toBe(true);
  });

  it('runs a calendar widget instead of the notice', async () => {
    renderWithProviders(<WidgetFrame instance={CALENDAR_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Calendar settings' })).toBeInTheDocument();
    expect(screen.queryByText(/needs the Homebase server/)).not.toBeInTheDocument();
  });

  it('preloads the code of every widget in the layout', async () => {
    const preloads = Object.fromEntries(
      ['calendar', 'mail'].map((type) => {
        const component = getWidgetDefinition(type)!.Component as { preload?: () => Promise<unknown> };
        return [type, vi.spyOn(component, 'preload').mockResolvedValue(undefined)];
      }),
    );
    await preloadWidgets(['calendar', 'mail'], 0);
    expect(preloads.calendar).toHaveBeenCalledTimes(1);
    expect(preloads.mail).toHaveBeenCalledTimes(1);
  });

  it('reads the capabilities when asked: the same module answers per page load', () => {
    expect(availableWidgetDefinitions()).toHaveLength(WIDGET_DEFINITIONS.length);
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    expect(availableWidgetDefinitions().map((d) => d.type)).not.toContain('calendar');
    expect(availableWidgetDefinitions()).toBe(availableWidgetDefinitions());
  });
});
