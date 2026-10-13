/**
 * Pages-build gating, read at render time from `getCapabilities()`. On the in-browser backend
 * (`setCapabilitiesForTests(capabilitiesFor(true, 'browser'))`) server-only widgets (mail, feeds)
 * disappear from "Add widget" and the default layout but keep their titles when a persisted layout
 * still has them; the calendar stays (Outlook.com calendars are read from the browser), as do the
 * Accounts and Calendars sections, and Diagnostics stays with this site's overview and this
 * browser's events (never asking a server). On the Portly server (hybrid mode,
 * `capabilitiesFor(true, 'server')`) the same page load offers everything.
 */
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { createDefaultLayout } from '../grid/defaultLayout.ts';
import { WidgetFrame } from '../grid/WidgetFrame.tsx';
import { ALL_SETTINGS_SECTIONS } from '../settings/nav.ts';
import { SettingsShell } from '../settings/SettingsShell.tsx';
import { WIDGET_DEFINITIONS, availableWidgetDefinitions, getWidgetDefinition, preloadWidgets } from '../widgets/registry.ts';
import { renderWithProviders } from './render.tsx';

const CALENDAR_INSTANCE = { id: 'w1', type: 'calendar', x: 0, y: 0, w: 4, h: 4, config: {}, frame: { showHeader: true, transparent: false } };
const MAIL_INSTANCE = { ...CALENDAR_INSTANCE, id: 'w2', type: 'mail' };

describe('static build gating (Pages build, in-browser backend)', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

  it('hides mail and feeds from the catalog and the default layout, but keeps the registry whole', () => {
    expect(WIDGET_DEFINITIONS.map((d) => d.type)).toContain('mail');
    expect(WIDGET_DEFINITIONS.map((d) => d.type)).toContain('feeds');
    expect(availableWidgetDefinitions().map((d) => d.type)).toEqual(['search', 'launchpad', 'calendar', 'todoist', 'weather', 'sports', 'clock']);
    // The calendar needs an Outlook.com app registration first: it is offered, not placed.
    const types = createDefaultLayout().items.map((i) => i.type);
    expect(types).toEqual(['search', 'clock', 'launchpad', 'weather', 'todoist']);
  });

  it('has the Accounts and Calendars sections (Outlook.com signs in and syncs from the browser)', () => {
    expect(ALL_SETTINGS_SECTIONS.map((s) => s.id)).toEqual(expect.arrayContaining(['accounts', 'calendars', 'general', 'diagnostics']));
  });

  it('opens Diagnostics with this site’s overview and this browser’s events, without asking a server', async () => {
    // The section is lazily loaded: load its code first, so a busy full run does not outlast the wait.
    await import('../settings/sections/Diagnostics.tsx');
    const { requests } = renderWithProviders(<SettingsShell section="diagnostics" />);
    expect(await screen.findByRole('tab', { name: 'Overview' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'This browser']);
    expect(screen.getByRole('region', { name: 'This site' })).toBeInTheDocument();
    expect(screen.queryByText(/needs the Portly server/)).not.toBeInTheDocument();
    expect(requests.filter((r) => r.path.startsWith('/api/diagnostics'))).toEqual([]);
  });

  it('renders a notice instead of a server-only widget that is still in a layout', async () => {
    renderWithProviders(<WidgetFrame instance={MAIL_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    expect(await screen.findByText('Mail needs the Portly server')).toBeInTheDocument();
    expect(screen.getByText(/Not available in the browser-only build/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mail settings/ })).not.toBeInTheDocument();
  });

  it('runs a calendar widget (Outlook.com from the browser)', async () => {
    renderWithProviders(<WidgetFrame instance={CALENDAR_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Calendar settings' })).toBeInTheDocument();
    expect(screen.queryByText(/needs the Portly server/)).not.toBeInTheDocument();
  });

  it('never preloads the code of widgets this page load cannot show', async () => {
    const preloads = Object.fromEntries(
      ['calendar', 'mail', 'clock'].map((type) => {
        const component = getWidgetDefinition(type)!.Component as { preload?: () => Promise<unknown> };
        return [type, vi.spyOn(component, 'preload').mockResolvedValue(undefined)];
      }),
    );
    await preloadWidgets(['calendar', 'mail', 'clock', 'clock'], 0);
    expect(preloads.calendar).toHaveBeenCalledTimes(1);
    expect(preloads.mail).not.toHaveBeenCalled();
    expect(preloads.clock).toHaveBeenCalledTimes(1);
  });
});

describe('static build gating (Pages build on the Portly server on this PC)', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('offers calendar, mail and feeds and the full default layout', () => {
    expect(availableWidgetDefinitions().map((d) => d.type)).toEqual(WIDGET_DEFINITIONS.map((d) => d.type));
    expect(createDefaultLayout().items.map((i) => i.type)).toEqual(['search', 'clock', 'launchpad', 'weather', 'calendar', 'todoist', 'mail']);
  });

  it('runs a calendar widget instead of the notice', async () => {
    renderWithProviders(<WidgetFrame instance={CALENDAR_INSTANCE} profileId="p1" editMode={false} onOpenSettings={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Calendar settings' })).toBeInTheDocument();
    expect(screen.queryByText(/needs the Portly server/)).not.toBeInTheDocument();
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
    expect(availableWidgetDefinitions().map((d) => d.type)).not.toContain('mail');
    expect(availableWidgetDefinitions()).toBe(availableWidgetDefinitions());
  });
});
