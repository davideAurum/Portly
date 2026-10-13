/**
 * A tiny in-memory stand-in for the core profile/settings routes (§7 Core), so tests that mutate
 * layouts see the same state on refetch that a real server would return.
 */
import { SettingsSchema, type Profile, type Settings, type WidgetFrame, type WidgetInstance } from '@portly/shared';
import { applyMergePatch } from '../lib/mergePatch.ts';
import { mockResponse, type ApiMock, type MockRequest } from './render.tsx';
import { health, settings as makeSettings } from './fixtures.ts';

export interface FakeServer {
  profiles: Profile[];
  settings: Settings;
  mocks: Record<string, ApiMock>;
}

function findProfile(server: FakeServer, id: string | undefined) {
  return server.profiles.find((p) => p.id === id);
}

function notFound() {
  return mockResponse(404, { error: { code: 'not_found', message: 'Not found' } });
}

export function createFakeServer(initial: Profile[], options: { settings?: Settings; vault?: 'ready' | 'locked' } = {}): FakeServer {
  let counter = 0;
  const server: FakeServer = {
    profiles: structuredClone(initial),
    settings: options.settings ?? makeSettings({ activeProfileId: initial[0]?.id ?? null }),
    mocks: {},
  };

  const withProfile = (fn: (profile: Profile, req: MockRequest) => unknown) => (req: MockRequest) => {
    const profile = findProfile(server, req.params.id);
    return profile ? fn(profile, req) : notFound();
  };

  server.mocks = {
    'GET /api/health': health(options.vault),
    'GET /api/settings': () => structuredClone(server.settings),
    'PATCH /api/settings': (req: MockRequest) => {
      server.settings = SettingsSchema.parse(applyMergePatch(server.settings, req.body));
      return structuredClone(server.settings);
    },
    'GET /api/profiles': () => structuredClone(server.profiles),
    'POST /api/profiles': (req: MockRequest) => {
      const body = req.body as { name: string; layout?: Profile['layout']; copyFromId?: string };
      const source = body.copyFromId ? findProfile(server, body.copyFromId) : undefined;
      const created: Profile = {
        id: `p-new-${++counter}`,
        name: body.name,
        sort: server.profiles.length,
        layout: structuredClone(body.layout ?? source?.layout ?? { version: 1, items: [] }),
      };
      server.profiles.push(created);
      return created;
    },
    'PATCH /api/profiles/:id': withProfile((profile, req) => {
      Object.assign(profile, req.body as object);
      return profile;
    }),
    'DELETE /api/profiles/:id': withProfile((profile) => {
      server.profiles = server.profiles.filter((p) => p !== profile);
      if (server.settings.activeProfileId === profile.id) server.settings.activeProfileId = null;
      return mockResponse(204);
    }),
    'POST /api/profiles/:id/activate': withProfile((profile) => {
      server.settings.activeProfileId = profile.id;
      // Like the real server: the updated settings.
      return structuredClone(server.settings);
    }),
    'PUT /api/profiles/:id/positions': withProfile((profile, req) => {
      for (const pos of (req.body as { items: WidgetInstance[] }).items) {
        const item = profile.layout.items.find((i) => i.id === pos.id);
        if (item) Object.assign(item, { x: pos.x, y: pos.y, w: pos.w, h: pos.h });
      }
      return mockResponse(204);
    }),
    'POST /api/profiles/:id/widgets': withProfile((profile, req) => {
      const body = req.body as { type: string; config?: unknown; frame?: Partial<WidgetFrame> };
      const bottom = profile.layout.items.reduce((max, i) => Math.max(max, i.y + i.h), 0);
      const frame: WidgetFrame = { showHeader: true, transparent: false };
      if (body.frame?.showHeader !== undefined) frame.showHeader = body.frame.showHeader;
      if (body.frame?.transparent !== undefined) frame.transparent = body.frame.transparent;
      const created: WidgetInstance = { id: `w-new-${++counter}`, type: body.type, x: 0, y: bottom, w: 4, h: 4, config: body.config ?? {}, frame };
      profile.layout.items.push(created);
      return created;
    }),
    'PATCH /api/profiles/:id/widgets/:wid': withProfile((profile, req) => {
      const item = profile.layout.items.find((i) => i.id === req.params.wid);
      if (!item) return notFound();
      const body = req.body as { config?: unknown; frame?: { title?: string | null; showHeader?: boolean; transparent?: boolean } };
      if (body.config !== undefined) item.config = body.config;
      if (body.frame) {
        if (body.frame.showHeader !== undefined) item.frame.showHeader = body.frame.showHeader;
        if (body.frame.transparent !== undefined) item.frame.transparent = body.frame.transparent;
        if (body.frame.title === null) delete item.frame.title;
        else if (body.frame.title !== undefined) item.frame.title = body.frame.title;
      }
      return item;
    }),
    'DELETE /api/profiles/:id/widgets/:wid': withProfile((profile, req) => {
      profile.layout.items = profile.layout.items.filter((i) => i.id !== req.params.wid);
      return mockResponse(204);
    }),
  };
  return server;
}
