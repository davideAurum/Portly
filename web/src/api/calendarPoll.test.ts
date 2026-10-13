import { afterEach, describe, expect, it } from 'vitest';
import { CALENDAR_REFETCH_MS, FIRST_SYNC_POLL_MS, FIRST_SYNC_POLL_WINDOW_MS, firstSyncInterval, resetFirstSyncPoll } from './calendar.ts';

afterEach(() => resetFirstSyncPoll());

describe('first-sync polling (WEB-2)', () => {
  it('polls fast only for a bounded window, restarting when the awaited accounts change', () => {
    const t0 = 1_000_000;
    expect(firstSyncInterval(true, 'acc-1', t0)).toBe(FIRST_SYNC_POLL_MS);
    expect(firstSyncInterval(true, 'acc-1', t0 + FIRST_SYNC_POLL_WINDOW_MS - 1)).toBe(FIRST_SYNC_POLL_MS);
    expect(firstSyncInterval(true, 'acc-1', t0 + FIRST_SYNC_POLL_WINDOW_MS)).toBe(CALENDAR_REFETCH_MS);
    expect(firstSyncInterval(true, 'acc-1', t0 + 60 * 60_000)).toBe(CALENDAR_REFETCH_MS);
    // A newly connected account: fast again.
    expect(firstSyncInterval(true, 'acc-1,acc-2', t0 + 60 * 60_000)).toBe(FIRST_SYNC_POLL_MS);
    // Nothing to wait for: normal interval, and the next wait starts a fresh window.
    expect(firstSyncInterval(false, 'acc-1,acc-2', t0 + 61 * 60_000)).toBe(CALENDAR_REFETCH_MS);
    expect(firstSyncInterval(true, 'acc-1,acc-2', t0 + 62 * 60_000)).toBe(FIRST_SYNC_POLL_MS);
  });
});
