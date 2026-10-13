/**
 * The browser's local network access permission: queried by its current name, then the Chrome
 * 142–144 alias; a browser that knows neither (the query throws) reads as `unsupported`; changes
 * reach subscribers.
 */
import { describe, expect, it, vi } from 'vitest';
import { LOOPBACK_PERMISSION_NAMES, createLoopbackPermissionSource, pageLoopbackPermissionSource, queryLoopbackPermission } from './permission.ts';

class FakeStatus extends EventTarget {
  state: string;

  constructor(state: string) {
    super();
    this.state = state;
  }

  change(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

/** A `navigator.permissions` that knows only `known` (others throw, as browsers do). */
function permissionsKnowing(known: string | null, status = new FakeStatus('prompt')) {
  const query = vi.fn(async ({ name }: { name: string }) => {
    if (name !== known) throw new TypeError(`'${name}' is not a valid enum value of type PermissionName.`);
    return status as unknown as PermissionStatus;
  });
  return { permissions: { query } as unknown as Pick<Permissions, 'query'>, query, status };
}

describe('queryLoopbackPermission', () => {
  it('asks for loopback-network first', async () => {
    const { permissions, query } = permissionsKnowing('loopback-network', new FakeStatus('granted'));
    expect(await queryLoopbackPermission(permissions)).toBe('granted');
    expect(query).toHaveBeenCalledTimes(1);
    expect(LOOPBACK_PERMISSION_NAMES[0]).toBe('loopback-network');
  });

  it('falls back to local-network-access (Chrome 142–144)', async () => {
    const { permissions, query } = permissionsKnowing('local-network-access', new FakeStatus('denied'));
    expect(await queryLoopbackPermission(permissions)).toBe('denied');
    expect(query.mock.calls.map(([d]) => d.name)).toEqual(['loopback-network', 'local-network-access']);
  });

  it('is unsupported when the browser knows neither name, or has no permissions API', async () => {
    expect(await queryLoopbackPermission(permissionsKnowing(null).permissions)).toBe('unsupported');
    expect(await queryLoopbackPermission(undefined)).toBe('unsupported');
  });

  it('an unexpected state reads as unsupported', async () => {
    expect(await queryLoopbackPermission(permissionsKnowing('loopback-network', new FakeStatus('weird')).permissions)).toBe('unsupported');
  });
});

describe('createLoopbackPermissionSource', () => {
  it('queries once and follows change events', async () => {
    const { permissions, query, status } = permissionsKnowing('loopback-network');
    const source = createLoopbackPermissionSource(permissions);
    const listener = vi.fn();
    const off = source.subscribe(listener);
    expect(await source.query()).toBe('prompt');
    expect(await source.query()).toBe('prompt');
    expect(query).toHaveBeenCalledTimes(1);
    status.change('granted');
    expect(listener).toHaveBeenCalledWith('granted');
    expect(await source.query()).toBe('granted');
    off();
    status.change('denied');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('without such a permission stays unsupported and never calls listeners', async () => {
    const source = createLoopbackPermissionSource(permissionsKnowing(null).permissions);
    const listener = vi.fn();
    source.subscribe(listener);
    expect(await source.query()).toBe('unsupported');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('pageLoopbackPermissionSource', () => {
  it('answers granted on a loopback page without asking the browser (Chrome says denied on http pages)', async () => {
    const { permissions, query } = permissionsKnowing('loopback-network', new FakeStatus('denied'));
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'preview.localhost']) {
      expect(await pageLoopbackPermissionSource(host, permissions).query()).toBe('granted');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('follows the browser permission on any other page', async () => {
    const { permissions } = permissionsKnowing('loopback-network', new FakeStatus('denied'));
    expect(await pageLoopbackPermissionSource('davideaurum.github.io', permissions).query()).toBe('denied');
  });
});
