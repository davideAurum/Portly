/**
 * Pairing API helpers: the redirect check that decides whether an approval may send the tab back
 * to the Pages site, the approval itself (POST, then a same-tab navigation only to an accepted
 * redirect), and the tolerant readers.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPairingReturnUrl } from '@homebase/shared';
import { mockError, mockResponse, stubApi } from '../test/render.tsx';
import { ApiError } from './client.ts';
import { PairingRedirectError, approvePairing, fetchPairings, pairingRedirectTarget, revokePairing } from './pairing.ts';

const NONCE = 'n'.repeat(43);
const TOKEN = 't'.repeat(43);
const PAGES_URL = 'https://user.github.io/homebase/';
const REDIRECT = buildPairingReturnUrl(PAGES_URL, { token: TOKEN, nonce: NONCE, instanceId: 'instance-1' });

function stubAssign() {
  const assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
  return assign;
}

describe('pairingRedirectTarget', () => {
  it('accepts exactly <pagesUrl>#/paired?… for this nonce', () => {
    expect(pairingRedirectTarget(REDIRECT, PAGES_URL, NONCE)).toBe(REDIRECT);
    // Root Pages sites work the same.
    const root = buildPairingReturnUrl('https://user.github.io/', { token: TOKEN, nonce: NONCE, instanceId: 'i' });
    expect(pairingRedirectTarget(root, 'https://user.github.io/', NONCE)).toBe(root);
  });

  it('refuses anything else', () => {
    const answer = REDIRECT.slice(REDIRECT.indexOf('#'));
    const refused: unknown[] = [
      null,
      42,
      '',
      answer,
      `https://user.github.io/other/${answer}`,
      `https://user.github.io/homebase/sub/${answer}`,
      `https://user.github.io/homebase/?x=1${answer}`,
      `https://user.github.io.evil.example/homebase/${answer}`,
      `https://evil.example/homebase/${answer}`,
      `http://user.github.io/homebase/${answer}`,
      `https://me@user.github.io/homebase/${answer}`,
      `javascript:alert(1)//${answer}`,
      PAGES_URL,
      `${PAGES_URL}#/`,
      `${PAGES_URL}#/paired?token=${TOKEN}&nonce=${NONCE}`,
    ];
    for (const value of refused) expect(pairingRedirectTarget(value, PAGES_URL, NONCE), String(value)).toBeNull();
    // Another tab's nonce.
    expect(pairingRedirectTarget(REDIRECT, PAGES_URL, 'm'.repeat(43))).toBeNull();
    // A Pages address that is not a folder cannot anchor the prefix check.
    expect(pairingRedirectTarget(REDIRECT, 'https://user.github.io/homebase', NONCE)).toBeNull();
    expect(pairingRedirectTarget(REDIRECT, 'not a url', NONCE)).toBeNull();
  });
});

describe('approvePairing', () => {
  it('posts the nonce and sends the tab to the redirect', async () => {
    const { requests } = stubApi({ 'POST /api/pairings': { redirectUrl: REDIRECT } });
    const assign = stubAssign();
    await approvePairing(NONCE, PAGES_URL);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({ nonce: NONCE });
    expect(requests[0]?.headers.get('X-Homebase')).toBe('1');
    expect(assign).toHaveBeenCalledWith(REDIRECT);
  });

  it('never navigates to a redirect outside the Pages address', async () => {
    stubApi({ 'POST /api/pairings': { redirectUrl: `https://evil.example/${REDIRECT.slice(REDIRECT.indexOf('#'))}` } });
    const assign = stubAssign();
    await expect(approvePairing(NONCE, PAGES_URL)).rejects.toBeInstanceOf(PairingRedirectError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports the server refusing as an ApiError', async () => {
    stubApi({ 'POST /api/pairings': mockError(409, 'not_configured', 'Pairing is off.') });
    const assign = stubAssign();
    await expect(approvePairing(NONCE, PAGES_URL)).rejects.toMatchObject({ code: 'not_configured', message: 'Pairing is off.' });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('fetchPairings / revokePairing', () => {
  it('drops fields a newer server adds instead of failing', async () => {
    stubApi({
      'GET /api/pairings': {
        pagesUrl: PAGES_URL,
        instanceId: 'instance-1',
        extra: true,
        pairings: [
          {
            id: 'p1',
            label: 'Edge on Windows',
            origin: 'https://user.github.io',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: null,
            current: true,
            future: 'x',
          },
        ],
      },
    });
    const data = await fetchPairings();
    expect(data).toEqual({
      pagesUrl: PAGES_URL,
      instanceId: 'instance-1',
      pairings: [{ id: 'p1', label: 'Edge on Windows', origin: 'https://user.github.io', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null, current: true }],
    });
  });

  it('encodes the id into the path', async () => {
    const { requests } = stubApi({ 'DELETE /api/pairings/:id': mockResponse(204) });
    await revokePairing('a/b');
    expect(requests[0]?.path).toBe('/api/pairings/a%2Fb');
    stubApi({ 'DELETE /api/pairings/:id': mockError(404, 'not_found') });
    await expect(revokePairing('gone')).rejects.toBeInstanceOf(ApiError);
  });
});
