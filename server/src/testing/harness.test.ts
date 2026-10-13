import { describe, expect, it } from 'vitest';
import { ProviderUnauthorizedError } from '../lib/errors.ts';
import { VaultLockedError, createMemoryVault } from '../security/vault.ts';
import { createFakeAccountService } from './fake-accounts.ts';
import { createFakeFetch } from './fake-fetch.ts';
import { createTestContext } from './test-context.ts';

describe('createTestContext', () => {
  it('builds a complete context with migrations applied and fakes wired in', async () => {
    const ctx = createTestContext({
      fetchRoutes: [{ match: 'api.open-meteo.com', respond: { json: { ok: 1 } } }],
      accounts: [{ id: 'g1', kind: 'google', capabilities: ['calendar', 'mail'], token: 'tok' }],
      secrets: { 'todoist:token': 't0k' },
    });
    expect(ctx.config.port).toBe(5757);
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events'")?.n).toBe(1);
    expect(ctx.settings.get('general').timeFormat).toBe('system');
    expect(ctx.vault.get('todoist:token')).toBe('t0k');
    expect(await ctx.accounts.getAccessToken('g1')).toBe('tok');
    const res = await ctx.fetch('https://api.open-meteo.com/v1/forecast', { policy: 'provider', as: 'json' });
    expect(res.data).toEqual({ ok: 1 });
    expect(ctx.fakeFetch?.calls).toHaveLength(1);
    ctx.cache.set('weather:x', 1, 1000);
    expect(ctx.cache.get('weather:x')).toBe(1);
    const job = ctx.scheduler.every('weather:refresh', 1000, () => {});
    expect(ctx.scheduler.jobs().map((j) => j.name)).toEqual(['weather:refresh']);
    job.stop();
    ctx.close();
  });

  it('uses a fresh database per context', () => {
    const a = createTestContext();
    const b = createTestContext();
    a.db.run("INSERT INTO settings (namespace, value, updated_at) VALUES ('general', '{}', 1)");
    expect(b.db.all('SELECT * FROM settings')).toEqual([]);
    a.close();
    b.close();
  });
});

describe('createFakeFetch', () => {
  it('matches by substring/RegExp and method, in order, honoring `times`', async () => {
    const fake = createFakeFetch([
      { match: /\/tasks\/\d+\/close$/, method: 'POST', respond: { status: 204 } },
      { match: 'example.com/once', respond: { text: 'first' }, times: 1 },
      { match: 'example.com/once', respond: { text: 'second' } },
      { match: 'example.com/dyn', respond: (req) => ({ json: { method: req.method, body: req.body } }) },
    ]);
    expect((await fake('https://api.todoist.com/api/v1/tasks/12/close', { method: 'POST' })).status).toBe(204);
    expect(await (await fake('https://example.com/once')).text()).toBe('first');
    expect(await (await fake('https://example.com/once')).text()).toBe('second');
    expect(await (await fake('https://example.com/dyn', { method: 'PUT', body: 'x' })).json()).toEqual({ method: 'PUT', body: 'x' });
    expect(fake.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'PUT']);
  });

  it('throws on unmatched requests and records them', async () => {
    const fake = createFakeFetch([]);
    await expect(fake('https://unexpected.example/')).rejects.toThrow(/no route/);
    expect(fake.unmatched.map((r) => r.url)).toEqual(['https://unexpected.example/']);
    // Clear so this intentional miss does not fail the test via the onTestFinished hook.
    fake.reset();
  });
});

describe('createFakeAccountService', () => {
  it('filters by kind and enabled capability', () => {
    const svc = createFakeAccountService([
      { id: 'g', kind: 'google', capabilities: ['calendar', 'mail'], enabledCapabilities: ['calendar'] },
      { id: 'y', kind: 'yahoo', capabilities: ['mail'], password: 'app-pw' },
    ]);
    expect(svc.list().map((a) => a.id)).toEqual(['g', 'y']);
    expect(svc.list({ capability: 'mail' }).map((a) => a.id)).toEqual(['y']);
    expect(svc.list({ kind: 'google' }).map((a) => a.id)).toEqual(['g']);
    expect(svc.get('nope')).toBeNull();
  });

  it('withToken retries once after ProviderUnauthorizedError and sets reauth when refresh fails', async () => {
    const svc = createFakeAccountService([{ id: 'g', kind: 'google', token: 'old', refreshedTokens: ['new'] }]);
    const seen: string[] = [];
    const result = await svc.withToken('g', async (token) => {
      seen.push(token);
      if (token === 'old') throw new ProviderUnauthorizedError('401');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['old', 'new']);
    expect(svc.refreshes.get('g')).toBe(1);

    await expect(
      svc.withToken('g', async () => {
        throw new ProviderUnauthorizedError('401');
      }),
    ).rejects.toMatchObject({ status: 409, code: 'reauth_required', accountId: 'g' });
    expect(svc.get('g')?.status).toBe('reauth');
    await expect(svc.getAccessToken('g')).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('returns canned secrets and records probes, statuses and change events', async () => {
    const svc = createFakeAccountService([{ id: 'y', kind: 'yahoo', password: 'app-pw', config: { username: 'me@yahoo.com' } }]);
    expect(await svc.getSecret('y')).toEqual({ password: 'app-pw' });
    expect(svc.getConfig<'yahoo'>('y').username).toBe('me@yahoo.com');
    svc.registerProbe('mail', ['yahoo', 'imap'], async () => ({}));
    expect(svc.probes).toHaveLength(1);
    svc.setStatus('y', 'error', 'IMAP timeout');
    expect(svc.get('y')).toMatchObject({ status: 'error', statusMessage: 'IMAP timeout' });
    const events: string[] = [];
    svc.onChange((e) => events.push(`${e.type}:${e.accountId}`));
    svc.emit({ type: 'deleted', accountId: 'y' });
    expect(events).toEqual(['deleted:y']);
  });
});

describe('memory vault', () => {
  it('round-trips secrets and refuses get/put while locked', async () => {
    const vault = createMemoryVault();
    vault.put('account:abc', '{"password":"x"}');
    expect(vault.get('account:abc')).toBe('{"password":"x"}');
    expect(vault.list('account:')).toEqual(['account:abc']);
    expect(() => vault.put('bad id', 'x')).toThrow(TypeError);
    vault.setState('locked');
    expect(vault.state).toBe('locked');
    expect(() => vault.get('account:abc')).toThrow(VaultLockedError);
    expect(vault.has('account:abc')).toBe(true);
    vault.delete('account:abc');
    expect(vault.has('account:abc')).toBe(false);
    await vault.reset();
    expect(vault.state).toBe('ready');
  });
});
