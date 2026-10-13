/** Test fixtures for the web shell. */
import { defaultSettings, type Account, type HealthResponse, type Profile, type Settings, type WidgetInstance } from '@portly/shared';

export function widget(id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<WidgetInstance> = {}): WidgetInstance {
  return { id, type, x, y, w, h, config: {}, frame: { showHeader: true, transparent: false }, ...extra };
}

export function profile(id: string, name: string, items: WidgetInstance[] = [], sort = 0): Profile {
  return { id, name, sort, layout: { version: 1, items } };
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), ...overrides };
}

export function health(vault: HealthResponse['vault'] = 'ready'): HealthResponse {
  return { ok: true, version: '0.0.0-test', vault };
}

export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    kind: 'google',
    label: 'Personal Gmail',
    email: 'me@example.com',
    color: '#3b82f6',
    capabilities: ['calendar', 'mail'],
    enabledCapabilities: ['calendar', 'mail'],
    status: 'ok',
    statusMessage: null,
    sort: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Mocks every request the shell makes on load, for a dashboard with the given profiles. */
export function shellMocks(profiles: Profile[], overrides: { settings?: Settings; vault?: HealthResponse['vault'] } = {}) {
  return {
    'GET /api/settings': overrides.settings ?? settings({ activeProfileId: profiles[0]?.id ?? null }),
    'GET /api/profiles': profiles,
    'GET /api/health': health(overrides.vault),
  };
}
