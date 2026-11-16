/**
 * Music module (§7 Music, §8 Spotify, §10.8 Music): a remote control for the music services
 * connected in Settings → Accounts. The sound plays on the user's own devices, in the provider's
 * apps; no audio and no script of the provider's ever reach the page, and the access token stays on
 * this server (§4).
 *
 * Routes (all non-exempt JSON routes, declared `paired()`: the paired Pages site and other PCs use
 * them too; signing in stays on the main PC, §4.2):
 * - `GET  /api/music/status[?accountId=]`   → `MusicStatus` (`playback` null: nothing is active)
 * - `GET  /api/music/devices[?accountId=]`  → `MusicDevice[]`
 * - `POST /api/music/command {accountId?, command}` → 204
 * - `GET  /api/music/phone`                 → `PhonePlayback | null` (phone.ts)
 * - `POST /api/music/phone {PhoneReport}`   → 204, declared `reporter()`: only a helper app on a
 *   phone, signed in as a device of that scope. Portly's own page and full devices are refused.
 *
 * Errors: no account → 409 `not_configured` (`details.reason: 'no_account'`); an account to
 * reconnect → 409 `reauth_required`; the rest as listed at `MUSIC_ERROR_REASONS` in shared. A 429
 * answer carries `Retry-After`.
 */
import type { Hono } from 'hono';
import { MusicCommandRequestSchema, MusicQuerySchema, PhoneReportSchema } from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { paired, reporter } from '../../lib/routes.ts';
import { parseBody, parseQuery } from '../../lib/validate.ts';
import { createPhoneReports } from './phone.ts';
import { createMusicService, type MusicServiceOptions } from './service.ts';

export const prefixes = ['/api/music'] as const;

export function register(app: Hono<AppEnv>, ctx: AppContext, options: MusicServiceOptions = {}): void {
  const service = createMusicService(ctx, options);
  const phone = createPhoneReports(ctx, { now: options.now });

  // A 429 (from the provider or the cooldown) tells the browser when to try again.
  app.use('/api/music/*', async (c, next) => {
    await next();
    const err = c.error;
    if (err instanceof HttpError && err.code === 'rate_limited') {
      const seconds = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (typeof seconds === 'number') c.header('Retry-After', String(seconds));
    }
  });

  app.get('/api/music/status', paired(), async (c) => {
    return c.json(await service.status(parseQuery(c, MusicQuerySchema)));
  });

  app.get('/api/music/devices', paired(), async (c) => {
    return c.json(await service.devices(parseQuery(c, MusicQuerySchema)));
  });

  app.post('/api/music/command', paired(), async (c) => {
    await service.command(await parseBody(c, MusicCommandRequestSchema));
    return c.body(null, 204);
  });

  app.get('/api/music/phone', paired(), (c) => c.json(phone.current()));

  app.post('/api/music/phone', reporter(), async (c) => {
    // The gate lets Portly's own page reach every route; only a device has something to report.
    const deviceId = c.get('deviceId');
    if (deviceId === undefined) throw HttpError.of('not_configured', 'Only the helper app on a phone reports what is playing');
    phone.report(deviceId, await parseBody(c, PhoneReportSchema));
    return c.body(null, 204);
  });
}
