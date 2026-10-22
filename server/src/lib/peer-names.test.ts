import { describe, expect, it, vi } from 'vitest';
import { createTestLogger } from './logger.ts';
import {
  PEER_NAME_CACHE_MAX,
  PEER_NAME_CACHE_MS,
  PEER_NAME_MAX_IN_FLIGHT,
  createPeerNames,
  isTailnetAddress,
  peerNameFromWhois,
  tailscaleExecutable,
} from './peer-names.ts';

/** A `tailscale whois --json` answer shaped like the real one (fictional node). */
function whois(node: Record<string, unknown>): string {
  return JSON.stringify({
    Node: {
      ID: 1,
      StableID: 'nABC',
      Name: 'study-laptop.tailnet-abcd.ts.net.',
      Addresses: ['100.101.102.103/32', 'fd7a:115c:a1e0::1234:5678/128'],
      Hostinfo: { OS: 'windows', Hostname: 'STUDY-LAPTOP', Services: null },
      ComputedName: 'study-laptop',
      ...node,
    },
    UserProfile: { ID: 2, LoginName: 'someone@example.com', DisplayName: 'Someone' },
    CapMap: null,
  });
}

describe('isTailnetAddress', () => {
  it.each(['100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1234:5678', 'FD7A:115C:A1E0:0:0:0:0:1'])('accepts %s', (address) => {
    expect(isTailnetAddress(address)).toBe(true);
  });

  it.each(['100.63.255.255', '100.128.0.1', '10.0.0.1', '127.0.0.1', '::1', 'fd7a:115c:a1e1::1', 'localhost', '100.64.0.1/32', '', ' 100.64.0.1'])(
    'rejects %s',
    (address) => {
      expect(isTailnetAddress(address)).toBe(false);
    },
  );
});

describe('peerNameFromWhois', () => {
  it('prefers the computer name, then the tailnet machine name, then the MagicDNS name', () => {
    expect(peerNameFromWhois(whois({}))).toBe('STUDY-LAPTOP');
    expect(peerNameFromWhois(whois({ Hostinfo: { OS: 'windows' } }))).toBe('study-laptop');
    expect(peerNameFromWhois(whois({ Hostinfo: {}, ComputedName: '' }))).toBe('study-laptop');
    expect(peerNameFromWhois(whois({ Hostinfo: null, ComputedName: 7, Name: 'other-pc.example.ts.net.' }))).toBe('other-pc');
  });

  it('skips a name that is not a usable label and cuts a long one to the label length', () => {
    expect(peerNameFromWhois(whois({ Hostinfo: { Hostname: 'bad\u0000name' } }))).toBe('study-laptop');
    expect(peerNameFromWhois(whois({ Hostinfo: { Hostname: '  padded  ' } }))).toBe('padded');
    expect(peerNameFromWhois(whois({ Hostinfo: { Hostname: 'x'.repeat(80) } }))).toBe('x'.repeat(60));
    // A character of two UTF-16 units across the cut is dropped whole, never half of it.
    expect(peerNameFromWhois(whois({ Hostinfo: { Hostname: `${'x'.repeat(59)}\u{1F4BB}y` } }))).toBe('x'.repeat(59));
    expect(peerNameFromWhois(whois({ Hostinfo: { Hostname: `${'x'.repeat(58)}\u{1F4BB}y` } }))).toBe(`${'x'.repeat(58)}\u{1F4BB}`);
  });

  it('answers null for anything that is not a whois answer', () => {
    expect(peerNameFromWhois('')).toBeNull();
    expect(peerNameFromWhois('not json')).toBeNull();
    expect(peerNameFromWhois('[]')).toBeNull();
    expect(peerNameFromWhois('{"Node": null}')).toBeNull();
    expect(peerNameFromWhois(JSON.stringify({ Node: { Hostinfo: { Hostname: '' }, ComputedName: ' ', Name: '.' } }))).toBeNull();
  });
});

describe('createPeerNames', () => {
  it('looks a tailnet address up once and caches the answer, including no answer', async () => {
    let clock = 1_000;
    const run = vi.fn(async (address: string) => (address === '100.101.102.103' ? whois({}) : '{}'));
    const names = createPeerNames({ log: createTestLogger(), run, now: () => clock });
    expect(await names.lookup('100.101.102.103')).toBe('STUDY-LAPTOP');
    expect(await names.lookup('100.101.102.103')).toBe('STUDY-LAPTOP');
    expect(await names.lookup('100.64.0.9')).toBeNull();
    expect(await names.lookup('100.64.0.9')).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    clock += PEER_NAME_CACHE_MS + 1;
    expect(await names.lookup('100.101.102.103')).toBe('STUDY-LAPTOP');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('runs at most a few lookups at once; further addresses get no name until one settles', async () => {
    const pending: ((value: string) => void)[] = [];
    const run = vi.fn(() => new Promise<string>((resolve) => pending.push(resolve)));
    const logs = createTestLogger();
    const names = createPeerNames({ log: logs, run });
    const asked = Array.from({ length: PEER_NAME_MAX_IN_FLIGHT + 2 }, (_, i) => names.lookup(`100.64.2.${i}`));
    expect(run).toHaveBeenCalledTimes(PEER_NAME_MAX_IN_FLIGHT);
    // The two beyond the cap answered null at once, and were not cached as such.
    expect(await asked[PEER_NAME_MAX_IN_FLIGHT]).toBeNull();
    expect(await asked[PEER_NAME_MAX_IN_FLIGHT + 1]).toBeNull();
    expect(logs.lines().filter((line) => line.msg === 'peer name lookup skipped')).toHaveLength(2);
    for (const resolve of pending) resolve(whois({}));
    expect(await Promise.all(asked.slice(0, PEER_NAME_MAX_IN_FLIGHT))).toEqual(Array(PEER_NAME_MAX_IN_FLIGHT).fill('STUDY-LAPTOP'));
    const later = names.lookup(`100.64.2.${PEER_NAME_MAX_IN_FLIGHT}`);
    expect(run).toHaveBeenCalledTimes(PEER_NAME_MAX_IN_FLIGHT + 1);
    pending[PEER_NAME_MAX_IN_FLIGHT]?.(whois({}));
    expect(await later).toBe('STUDY-LAPTOP');
  });

  it('shares one lookup between callers that ask at the same time', async () => {
    let release: (value: string) => void = () => {};
    const run = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const names = createPeerNames({ log: createTestLogger(), run });
    const first = names.lookup('100.101.102.103');
    const second = names.lookup('100.101.102.103');
    release(whois({}));
    expect(await Promise.all([first, second])).toEqual(['STUDY-LAPTOP', 'STUDY-LAPTOP']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never runs anything for an address outside the tailnet ranges', async () => {
    const run = vi.fn(async () => whois({}));
    const names = createPeerNames({ log: createTestLogger(), run });
    expect(await names.lookup('127.0.0.1')).toBeNull();
    expect(await names.lookup('10.1.2.3')).toBeNull();
    expect(await names.lookup('100.101.102.103; rm -rf')).toBeNull();
    expect(await names.lookup('')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('answers null when the program fails, and logs the reason without the address or a name', async () => {
    const logs = createTestLogger();
    const run = vi.fn(async () => {
      throw new Error('exit code 1');
    });
    const names = createPeerNames({ log: logs, run });
    expect(await names.lookup('100.101.102.103')).toBeNull();
    expect(logs.lines().find((line) => line.msg === 'peer name lookup failed')).toMatchObject({ level: 'debug', fields: { reason: 'exit code 1' } });
    expect(JSON.stringify(logs.lines())).not.toContain('100.101.102.103');
  });

  it('keeps the cache bounded', async () => {
    const run = vi.fn(async () => '{}');
    const names = createPeerNames({ log: createTestLogger(), run });
    for (let i = 0; i < PEER_NAME_CACHE_MAX + 5; i += 1) await names.lookup(`100.64.1.${i}`);
    expect(run).toHaveBeenCalledTimes(PEER_NAME_CACHE_MAX + 5);
    // The oldest entries were dropped: asking for the first again runs once more.
    await names.lookup('100.64.1.0');
    expect(run).toHaveBeenCalledTimes(PEER_NAME_CACHE_MAX + 6);
    // The newest is still cached.
    await names.lookup(`100.64.1.${PEER_NAME_CACHE_MAX + 4}`);
    expect(run).toHaveBeenCalledTimes(PEER_NAME_CACHE_MAX + 6);
  });

  it('answers null everywhere when Tailscale is not installed, saying so once', async () => {
    const logs = createTestLogger();
    const names = createPeerNames({ log: logs, executable: null });
    expect(await names.lookup('100.101.102.103')).toBeNull();
    expect(await names.lookup('100.64.0.9')).toBeNull();
    expect(logs.lines().filter((line) => line.msg.startsWith('Tailscale is not installed here'))).toHaveLength(1);
  });

  it('looks for tailscale.exe where the installer puts it, on Windows only', () => {
    expect(tailscaleExecutable({ ProgramFiles: 'C:\\No Such Folder' }, 'win32')).toBeNull();
    expect(tailscaleExecutable({}, 'linux')).toBeNull();
  });
});
