/** Display metadata for account kinds and capabilities. */
import { CalendarDays, CloudSync, Mail, Music, type LucideIcon } from 'lucide-react';
import { isOAuthProvider, type AccountKind, type Capability, type OAuthProvider } from '@portly/shared';

export const ACCOUNT_KIND_LABELS: Readonly<Record<AccountKind, string>> = Object.freeze({
  google: 'Google',
  microsoft: 'Outlook.com',
  yahoo: 'Yahoo',
  caldav: 'CalDAV',
  imap: 'IMAP mail',
  spotify: 'Spotify',
});

export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = Object.freeze({
  calendar: 'Calendar',
  mail: 'Mail',
  launchpadSync: 'Launch pad sync',
  music: 'Music',
});

export const CAPABILITY_ICONS: Readonly<Record<Capability, LucideIcon>> = Object.freeze({
  calendar: CalendarDays,
  mail: Mail,
  launchpadSync: CloudSync,
  music: Music,
});

/** Google, Microsoft and Spotify accounts reconnect through OAuth; others by re-entering a password. */
export function reconnectsWithOAuth(kind: AccountKind): kind is OAuthProvider {
  return isOAuthProvider(kind);
}
