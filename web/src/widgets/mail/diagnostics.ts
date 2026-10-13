/**
 * The mail widget's per-account failures as this browser's `widget` events (ARCHITECTURE §17). The
 * summary answers 200 with an `error` for each account that could not be listed; an event is
 * recorded when an account's error code changes — warn when a failure starts or changes, info when
 * it clears — not on every refetch, and not on every page load: an account seen for the first time
 * in this page load is compared with its last event in this browser's log (which survives reloads),
 * so an account that keeps failing for days is one event, not one per new tab. One record per
 * account for the whole page (several mail widgets show the same accounts). Fields: `widget`,
 * `accountId`, `code` and `status` (the provider's HTTP status when the error carries one, else the
 * one Portly answers that code with); never the error's message, a subject or an address.
 */
import { ERROR_CODES, ERROR_STATUS, type ErrorCode, type MailAccountSummary } from '@portly/shared';
import { clientSessionId, getClientEvents, recordClientEvent } from '../../diagnostics/clientLog.ts';

/** accountId → the error code last seen (null: listed fine). */
const lastCodes = new Map<string, string | null>();
/** The event log's session `lastCodes` belongs to (a new one — tests reset it — starts afresh). */
let session: string | null = null;

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

function statusOf(error: NonNullable<MailAccountSummary['error']>): number | null {
  const details = error.details;
  if (details !== null && typeof details === 'object') {
    for (const key of ['upstreamStatus', 'status']) {
      const value = (details as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
  }
  return KNOWN_CODES.has(error.code) ? ERROR_STATUS[error.code as ErrorCode] : null;
}

/** The code of the account's last mail event in this browser's log (null: listed again), or undefined when it has none. */
function loggedCode(accountId: string): string | null | undefined {
  const entries = getClientEvents();
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]!.event;
    if (event.cat !== 'widget' || event.fields.widget !== 'mail' || event.fields.accountId !== accountId) continue;
    return typeof event.fields.code === 'string' ? event.fields.code : null;
  }
  return undefined;
}

/** Records the accounts whose error code changed since the last summary (never throws). */
export function reportMailAccountErrors(summaries: readonly MailAccountSummary[]): void {
  try {
    const current = clientSessionId();
    if (current !== session) {
      lastCodes.clear();
      session = current;
    }
    for (const summary of summaries) {
      const error = summary.error;
      const code = error?.code ?? null;
      const before = lastCodes.has(summary.accountId) ? lastCodes.get(summary.accountId) : loggedCode(summary.accountId);
      lastCodes.set(summary.accountId, code);
      // Unchanged, or never failed and fine.
      if (before === code || (before === undefined && code === null)) continue;
      if (error === undefined) recordClientEvent('info', 'widget', 'mail account listed again', { widget: 'mail', accountId: summary.accountId });
      else recordClientEvent('warn', 'widget', 'mail account failing', { widget: 'mail', accountId: summary.accountId, code: error.code, status: statusOf(error) });
    }
  } catch {
    // Diagnostics never disturb the widget.
  }
}
