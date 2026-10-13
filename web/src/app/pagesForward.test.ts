import { describe, expect, it, vi } from 'vitest';
import { forwardToPages, type PagesForwardDeps } from './pagesForward.ts';

function setup(overrides: Partial<PagesForwardDeps> & { hash?: string; search?: string } = {}) {
  const replace = vi.fn();
  const location = { hash: overrides.hash ?? '#/settings/accounts', search: overrides.search ?? '', replace };
  const pagesUrl = vi.fn(overrides.pagesUrl ?? (async () => 'https://user.github.io/'));
  const probe = vi.fn(overrides.probe ?? (async () => undefined));
  const run = () => forwardToPages({ location, framed: overrides.framed ?? false, pagesUrl, probe, timeoutMs: 50 });
  return { run, replace, pagesUrl, probe };
}

describe('forwardToPages', () => {
  it('forwards to the Pages site, keeping the query and hash route', async () => {
    const t = setup({ search: '?oauth=connected' });
    expect(await t.run()).toBe('forwarded');
    expect(t.probe).toHaveBeenCalledWith('https://user.github.io/', expect.any(AbortSignal));
    expect(t.replace).toHaveBeenCalledWith('https://user.github.io/?oauth=connected#/settings/accounts');
  });

  it('stays on #/pair, where a pairing is approved, without asking the server', async () => {
    const t = setup({ hash: '#/pair?nonce=abc' });
    expect(await t.run()).toBe('stay');
    expect(t.pagesUrl).not.toHaveBeenCalled();
    expect(t.replace).not.toHaveBeenCalled();
  });

  it.each(['#/settings/diagnostics', '#/settings/diagnostics?x=1'])('stays on %s, where full diagnostics can always be opened, without asking the server', async (hash) => {
    const t = setup({ hash });
    expect(await t.run()).toBe('stay');
    expect(t.pagesUrl).not.toHaveBeenCalled();
    expect(t.probe).not.toHaveBeenCalled();
    expect(t.replace).not.toHaveBeenCalled();
  });

  it('forwards every other settings section (and an unknown one) as before', async () => {
    for (const hash of ['#/settings/about', '#/settings/diagnosticsx', '#/settings']) {
      const t = setup({ hash });
      expect(await t.run()).toBe('forwarded');
      expect(t.replace).toHaveBeenCalledWith(`https://user.github.io/${hash}`);
    }
  });

  it('stays in a frame', async () => {
    const t = setup({ framed: true });
    expect(await t.run()).toBe('stay');
    expect(t.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['no Pages site configured', null],
    ['a non-https address', 'http://user.github.io/'],
    ['an address with a hash', 'https://user.github.io/#x'],
    ['a script URL', 'javascript:alert(1)'],
  ])('stays with %s', async (_label, url) => {
    const t = setup({ pagesUrl: async () => url });
    expect(await t.run()).toBe('stay');
    expect(t.probe).not.toHaveBeenCalled();
    expect(t.replace).not.toHaveBeenCalled();
  });

  it('accepts a Pages build served on this PC over http', async () => {
    const t = setup({ pagesUrl: async () => 'http://localhost:5173/' });
    expect(await t.run()).toBe('forwarded');
    expect(t.replace).toHaveBeenCalledWith('http://localhost:5173/#/settings/accounts');
  });

  it('stays when the server cannot say where the Pages site is', async () => {
    const t = setup({
      pagesUrl: async () => {
        throw new Error('down');
      },
    });
    expect(await t.run()).toBe('stay');
  });

  it('is the offline fallback when the Pages site cannot be reached', async () => {
    const t = setup({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await t.run()).toBe('offline');
    expect(t.replace).not.toHaveBeenCalled();
  });
});
