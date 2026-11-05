/**
 * A music provider (§8, §10.8 Music). Adding a service is one file implementing this, its OAuth
 * spec (`modules/accounts/oauth/<provider>.ts`) and an entry in `MUSIC_PROVIDERS`: the service, the
 * routes and the widget never name a provider.
 *
 * Failures are `HttpError`s with the §7a codes and, for what the widget treats on its own, a
 * `details.reason` from `MUSIC_ERROR_REASONS` (`ProviderHttpError` keeps the provider's own reason
 * and `Retry-After` for logs and health). A 401 inside `AccountService.withToken` is a
 * `ProviderUnauthorizedError`, so the service refreshes the token and retries once.
 *
 * Results hold the user's listening history: providers never log titles or artists (§17).
 */
import type { MusicCommand, MusicDevice, MusicFeatures, MusicPlayback } from '@portly/shared';

export interface MusicProvider {
  /** Name used in messages. */
  readonly displayName: string;
  /** What this provider can do at all. */
  readonly features: MusicFeatures;
  /** What is playing, or null when nothing is active on any device. */
  playback(accountId: string): Promise<MusicPlayback | null>;
  /** Devices that can play right now (those with an id: the others cannot be picked). */
  devices(accountId: string): Promise<MusicDevice[]>;
  send(accountId: string, command: MusicCommand): Promise<void>;
}
