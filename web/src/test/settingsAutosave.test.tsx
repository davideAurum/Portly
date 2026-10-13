import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '@homebase/shared';
import { qk } from '../api/keys.ts';
import { useSettingsAutosave } from '../api/settings.ts';
import { createFakeServer } from './fakeServer.ts';
import { createTestQueryClient, mockResponse, stubApi, type MockRequest } from './render.tsx';

function setup(initial: Settings, extraMocks: Record<string, unknown> = {}) {
  const server = createFakeServer([], { settings: structuredClone(initial) });
  const { requests } = stubApi({ ...server.mocks, ...extraMocks });
  const client = createTestQueryClient();
  client.setQueryData(qk.settings(), structuredClone(initial));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useSettingsAutosave(20), { wrapper });
  const patches = () => requests.filter((r) => r.method === 'PATCH' && r.path === '/api/settings').map((r) => r.body);
  return { server, client, hook, patches };
}

function customized(): Settings {
  const s = defaultSettings();
  s.appearance = { ...s.appearance, mode: 'dark', radius: 3, accent: '#123456' };
  return s;
}

describe('useSettingsAutosave', () => {
  it('combines rapid edits into one request', async () => {
    const { hook, patches, server } = setup(defaultSettings());
    act(() => {
      hook.result.current.save({ appearance: { radius: 4 } });
      hook.result.current.save({ appearance: { radius: 6 } });
      hook.result.current.save({ appearance: { mode: 'dark' } });
    });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ appearance: { radius: 6, mode: 'dark' } });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    expect(server.settings.appearance).toMatchObject({ radius: 6, mode: 'dark' });
  });

  it('never folds an edit into a pending reset (the reset reaches the server first)', async () => {
    const { hook, patches, server, client } = setup(customized());
    act(() => {
      hook.result.current.save({ appearance: null });
      hook.result.current.save({ appearance: { accent: '#ff0000' } });
    });
    // The page previews "defaults + red accent" immediately…
    expect(client.getQueryData<Settings>(qk.settings())?.appearance).toMatchObject({ mode: 'system', radius: 12, accent: '#ff0000' });
    // …and the server ends up in the same state.
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()).toEqual([{ appearance: null }, { appearance: { accent: '#ff0000' } }]);
    await waitFor(() => expect(server.settings.appearance).toMatchObject({ mode: 'system', radius: 12, accent: '#ff0000' }));
    expect(client.getQueryData<Settings>(qk.settings())?.appearance).toEqual(server.settings.appearance);
  });

  it('keeps sending queued edits after the component unmounts mid-save', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createFakeServer([], { settings: defaultSettings() });
    const patchSettings = server.mocks['PATCH /api/settings'] as (req: MockRequest) => unknown;
    const { hook, patches } = setup(defaultSettings(), {
      'PATCH /api/settings': async (req: MockRequest) => {
        await gate;
        return patchSettings(req);
      },
    });
    act(() => hook.result.current.save({ appearance: { radius: 4 } }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    // A second edit while the first request is in flight, then the page goes away.
    act(() => hook.result.current.save({ appearance: { radius: 9 } }));
    hook.unmount();
    release();
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual({ appearance: { radius: 9 } });
  });

  it('restores the last confirmed settings when a save fails', async () => {
    const { hook, client, patches } = setup(customized(), {
      'PATCH /api/settings': mockResponse(422, { error: { code: 'validation_failed', message: 'Nope' } }),
    });
    act(() => hook.result.current.save({ appearance: { radius: 20 } }));
    expect(client.getQueryData<Settings>(qk.settings())?.appearance.radius).toBe(20);
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(client.getQueryData<Settings>(qk.settings())?.appearance.radius).toBe(3));
  });
});
