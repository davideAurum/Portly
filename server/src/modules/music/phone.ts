/**
 * What the phone is playing (docs/design/phone-now-playing.md): the latest report of a `reporter`
 * device, held for the Music widget.
 *
 * - **Memory only.** A report is listening history, so it is never written to SQLite, the shared
 *   cache or a log. A restart forgets it.
 * - **Latest wins.** One report is held. A phone clears only its own with `stopped`.
 * - **Going stale.** A playing report with no follow-up for {@link PHONE_PLAYING_STALE_MS} is gone:
 *   the phone has left the network or switched off. A paused one stays for
 *   {@link PHONE_PAUSED_KEPT_MS}.
 * - **A removed device.** Every read checks that the reporting device still works, so revoking it,
 *   or it disconnecting, expiring or being evicted, hides its report at once. The next read or
 *   report then drops it from memory.
 * - **Position.** A playing position is moved on by the report's age times the speed, never past
 *   the end, and each report corrects it.
 * - **Limit.** One report per {@link PHONE_REPORT_INTERVAL_MS} per device, then 429 with `Retry-After`.
 * - **Health.** Each report taken is an OK for the subject `phone:<deviceId>`, which is how
 *   Diagnostics knows when the last one came. It carries the device id and nothing of the report.
 */
import type { PhonePlayback, PhoneReport } from '@portly/shared';
import type { AppContext } from '../../context.ts';
import { msToIsoStrict } from '../../db/helpers.ts';
import { HttpError } from '../../lib/errors.ts';

/** How long a playing report lasts without a follow-up. The helper reports every 30 s while playing. */
export const PHONE_PLAYING_STALE_MS = 90_000;
/** How long a paused report is kept (decision 4 of the design). */
export const PHONE_PAUSED_KEPT_MS = 15 * 60 * 1000;
export const PHONE_REPORT_INTERVAL_MS = 1_000;

export function phoneHealthKey(deviceId: string): string {
  return `phone:${deviceId}`;
}

type ShownReport = Exclude<PhoneReport, { state: 'stopped' }>;

interface Held {
  deviceId: string;
  report: ShownReport;
  /** Epoch ms the report arrived. */
  at: number;
  /** Epoch ms this state began. */
  startedAt: number;
}

export interface PhoneReports {
  /** Takes a device's report (`stopped` clears what that device reported). */
  report(deviceId: string, report: PhoneReport): void;
  /** What to show now, or null. */
  current(): PhonePlayback | null;
}

function sameEpisode(a: ShownReport, b: ShownReport): boolean {
  return a.episodeId !== null && b.episodeId !== null ? a.episodeId === b.episodeId : a.title === b.title;
}

export function createPhoneReports(ctx: Pick<AppContext, 'devices' | 'health'>, options: { now?: () => number } = {}): PhoneReports {
  const { devices, health } = ctx;
  const now = options.now ?? Date.now;
  let held: Held | null = null;
  /** Devices that reported within the last interval, with when. */
  const recent = new Map<string, number>();

  /** The held report, dropping it when it went stale or its device stopped working. */
  const live = (at: number): Held | null => {
    if (held === null) return null;
    const kept = held.report.state === 'playing' ? PHONE_PLAYING_STALE_MS : PHONE_PAUSED_KEPT_MS;
    if (at - held.at > kept || !devices.isConnected(held.deviceId)) held = null;
    return held;
  };

  const notTooFast = (deviceId: string, at: number): void => {
    for (const [id, last] of recent) if (at - last >= PHONE_REPORT_INTERVAL_MS) recent.delete(id);
    if (recent.has(deviceId)) throw HttpError.of('rate_limited', 'One report a second is enough', { retryAfterSeconds: 1 });
    recent.set(deviceId, at);
  };

  return {
    report(deviceId, report) {
      const at = now();
      notTooFast(deviceId, at);
      health.record({ key: phoneHealthKey(deviceId), area: 'music' }, { ok: true });
      const before = live(at);
      const mine = before?.deviceId === deviceId ? before : null;
      if (report.state === 'stopped') {
        if (mine !== null) held = null;
        return;
      }
      const continuing = mine !== null && mine.report.state === report.state && sameEpisode(mine.report, report);
      held = { deviceId, report, at, startedAt: continuing ? mine.startedAt : at };
    },

    current() {
      const at = now();
      const shown = live(at);
      if (shown === null) return null;
      const { app, state, title, show, durationMs, positionMs, speed } = shown.report;
      const moved = state === 'playing' ? Math.round((at - shown.at) * speed) : 0;
      return {
        app,
        state,
        title,
        show,
        durationMs,
        positionMs: durationMs === null ? positionMs + moved : Math.min(positionMs + moved, durationMs),
        speed,
        startedAt: msToIsoStrict(shown.startedAt),
      };
    },
  };
}
