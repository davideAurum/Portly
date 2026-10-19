/**
 * What Settings → Accounts offers to connect (§7 Accounts, §10.5): the tiles under "Add a
 * connection" and, per connection, the services it can be used for, each with a one-line
 * description. Data only.
 *
 * A new service is one entry in {@link SERVICE_DESCRIPTIONS} and {@link PAGE_SUPPORT}, plus its
 * capability (shared/src/accounts.ts) and its scopes (server: modules/accounts/oauth/<provider>.ts;
 * the browser-only build: static/providers/microsoftAuth.ts). Only services Portly has built are
 * listed: nothing "coming later".
 *
 * What this page load can do decides what is offered (`getCapabilities()`): on the in-browser
 * backend only Microsoft (calendar only, signed in from the browser) and Todoist work; Google,
 * Yahoo, CalDAV and IMAP need the Portly server.
 */
import { CAPABILITIES, OAUTH_PROVIDER_CAPABILITIES, type AccountKind, type Capability, type OAuthProvider } from '@portly/shared';
import { getCapabilities, type Capabilities } from '../../../capabilities.ts';
import { CAPABILITY_LABELS } from '../../../ui/accounts/accountKinds.ts';

export type ConnectionId = OAuthProvider | 'yahoo' | 'todoist' | 'other';

export interface ConnectionInfo {
  id: ConnectionId;
  /** Tile and dialog name. */
  title: string;
  /** The tile's letter mark and its color (`null`: an icon instead). */
  mark: { letter: string; color: string } | null;
  /** Whether this page load can connect it. */
  available(caps: Capabilities): boolean;
}

/** The tiles, in display order. */
export const CONNECTIONS: readonly ConnectionInfo[] = Object.freeze([
  { id: 'google', title: 'Google', mark: { letter: 'G', color: '#1a73e8' }, available: (caps) => caps.googleAccounts },
  { id: 'microsoft', title: 'Microsoft', mark: { letter: 'M', color: '#0f6cbd' }, available: (caps) => caps.accounts },
  { id: 'yahoo', title: 'Yahoo', mark: { letter: 'Y', color: '#5f01d1' }, available: (caps) => caps.appPasswordAccounts },
  { id: 'todoist', title: 'Todoist', mark: { letter: 'T', color: '#dc4c3e' }, available: () => true },
  { id: 'other', title: 'Other', mark: null, available: (caps) => caps.appPasswordAccounts },
]);

export function connectionInfo(id: ConnectionId): ConnectionInfo {
  const info = CONNECTIONS.find((c) => c.id === id);
  if (!info) throw new Error(`Unknown connection: ${id}`);
  return info;
}

/** The connections this page load can offer. */
export function availableConnections(caps: Capabilities = getCapabilities()): ConnectionInfo[] {
  return CONNECTIONS.filter((c) => c.available(caps));
}

/** Connections with services to pick (Todoist has one: its tasks). */
export type ServiceConnection = Exclude<ConnectionId, 'todoist'>;

/** One line per service and connection, shown next to its checkbox or switch. */
const SERVICE_DESCRIPTIONS: Readonly<Record<ServiceConnection, Readonly<Partial<Record<Capability, string>>>>> = Object.freeze({
  google: {
    calendar: 'See, add and edit events in your Google calendars.',
    mail: 'Unread Gmail at a glance: mark as read, archive or delete.',
  },
  microsoft: {
    calendar: 'See, add and edit events in your Outlook.com calendars.',
    mail: 'Unread Outlook.com mail at a glance: mark as read, archive or delete.',
  },
  yahoo: {
    calendar: 'Your Yahoo calendars, read-only (CalDAV).',
    mail: 'Unread Yahoo Mail at a glance (IMAP).',
  },
  other: {
    calendar: 'A CalDAV calendar: Nextcloud, Fastmail, iCloud and others. Read-only for now.',
    mail: 'Any IMAP mailbox: unread count and recent messages.',
  },
});

/** Whether this page load can use a service at all (the in-browser backend has no mail). */
const PAGE_SUPPORT: Readonly<Record<Capability, (caps: Capabilities) => boolean>> = Object.freeze({
  calendar: (caps) => caps.calendar,
  mail: (caps) => caps.mail,
});

/** The services each connection can offer, before this page load's limits. */
const OFFERED: Readonly<Record<ServiceConnection, readonly Capability[]>> = Object.freeze({
  ...OAUTH_PROVIDER_CAPABILITIES,
  yahoo: CAPABILITIES,
  other: CAPABILITIES,
});

export interface ServiceInfo {
  capability: Capability;
  label: string;
  description: string;
}

/** The services a connection offers on this page load, in capability order. */
export function connectionServices(id: ServiceConnection, caps: Capabilities = getCapabilities()): ServiceInfo[] {
  const descriptions = SERVICE_DESCRIPTIONS[id];
  return OFFERED[id].flatMap((capability) => {
    const description = descriptions[capability];
    return description !== undefined && PAGE_SUPPORT[capability](caps) ? [{ capability, label: CAPABILITY_LABELS[capability], description }] : [];
  });
}

/** The connection an account kind belongs to (CalDAV and IMAP accounts are "Other"). */
export function connectionOfKind(kind: AccountKind): ServiceConnection {
  return kind === 'caldav' || kind === 'imap' ? 'other' : kind;
}

/** The one-line description of an account's service. */
export function serviceDescription(kind: AccountKind, capability: Capability): string {
  return SERVICE_DESCRIPTIONS[connectionOfKind(kind)][capability] ?? '';
}

/** "Calendar and mail" for a tile. */
export function servicesSummary(services: readonly { label: string }[]): string {
  const labels = services.map((s, i) => (i === 0 ? s.label : s.label.toLowerCase()));
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
