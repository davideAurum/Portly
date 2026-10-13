/**
 * The mail widget's `widget` events: one when an account's error code changes (warn when a failure
 * starts or changes, info when it clears), none on refetches or reloads that change nothing; the
 * provider's status when the error carries one; never the error's message.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MailAccountSummary } from '@homebase/shared';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { reportMailAccountErrors } from './diagnostics.ts';

function summary(accountId: string, error?: MailAccountSummary['error']): MailAccountSummary {
  return { accountId, label: `Account ${accountId}`, email: `${accountId}@example.com`, color: null, unread: 0, messages: [], webmailUrl: null, canArchive: false, ...(error ? { error } : {}) };
}

const events = () => getClientEvents().map((entry) => entry.event);

describe('reportMailAccountErrors', () => {
  it('records a change of an account error code, once', () => {
    reportMailAccountErrors([summary('g1'), summary('m1')]);
    expect(events()).toEqual([]);

    const throttled = { code: 'rate_limited' as const, message: 'Gmail is rate limiting a@example.com', details: { upstreamStatus: 429 }, accountId: 'g1' };
    reportMailAccountErrors([summary('g1', throttled), summary('m1')]);
    reportMailAccountErrors([summary('g1', throttled), summary('m1')]);
    expect(events()).toEqual([
      expect.objectContaining({ level: 'warn', cat: 'widget', msg: 'mail account failing', fields: { widget: 'mail', accountId: 'g1', code: 'rate_limited', status: 429 } }),
    ]);
    expect(JSON.stringify(events())).not.toContain('example.com');

    reportMailAccountErrors([summary('g1', { code: 'reauth_required', message: 'Reconnect' }), summary('m1')]);
    reportMailAccountErrors([summary('g1'), summary('m1')]);
    expect(events().slice(1)).toEqual([
      expect.objectContaining({ level: 'warn', fields: { widget: 'mail', accountId: 'g1', code: 'reauth_required', status: 409 } }),
      expect.objectContaining({ level: 'info', msg: 'mail account listed again', fields: { widget: 'mail', accountId: 'g1' } }),
    ]);
  });

  it('an account failing the first time it is seen is recorded too', () => {
    reportMailAccountErrors([summary('i1', { code: 'provider_error', message: 'Mail could not be loaded' })]);
    expect(events()).toEqual([expect.objectContaining({ fields: { widget: 'mail', accountId: 'i1', code: 'provider_error', status: 502 } })]);
  });

  it('after a reload, an account that still fails the same way is not recorded again', async () => {
    const failing = summary('i1', { code: 'provider_error', message: 'Mail could not be loaded' });
    reportMailAccountErrors([failing]);
    expect(events()).toHaveLength(1);
    // A new page load: fresh modules, the event log read back from storage.
    vi.resetModules();
    const reloaded = await import('./diagnostics.ts');
    const log = await import('../../diagnostics/clientLog.ts');
    reloaded.reportMailAccountErrors([failing]);
    expect(log.getClientEvents()).toHaveLength(1);
    reloaded.reportMailAccountErrors([summary('i1')]);
    expect(log.getClientEvents().at(-1)?.event).toMatchObject({ level: 'info', msg: 'mail account listed again' });
  });
});
