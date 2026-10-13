/**
 * IMAP message ids (§4.10): base64url(`${mailbox}\n${uidValidity}\n${uid}`). The id pins the
 * mailbox generation, so an action on a mailbox whose UIDVALIDITY changed is refused (409
 * `conflict`, `stale_message`) instead of touching whatever message now carries that UID.
 */
export interface ImapMessageRef {
  mailbox: string;
  /** UIDVALIDITY as a decimal string (it is a 32-bit unsigned value; imapflow reports a bigint). */
  uidValidity: string;
  uid: number;
}

const MAX_MAILBOX_LENGTH = 1000;
const MAX_UINT32 = 4_294_967_295;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeImapId(ref: { mailbox: string; uidValidity: bigint | number | string; uid: number }): string {
  return Buffer.from(`${ref.mailbox}\n${String(ref.uidValidity)}\n${ref.uid}`, 'utf8').toString('base64url');
}

/** Parses an id; null for anything that is not exactly what {@link encodeImapId} produces. */
export function decodeImapId(id: unknown): ImapMessageRef | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 2048 || !BASE64URL.test(id)) return null;
  const text = Buffer.from(id, 'base64url').toString('utf8');
  const parts = text.split('\n');
  if (parts.length !== 3) return null;
  const [mailbox, uidValidity, uidText] = parts as [string, string, string];
  if (mailbox.length === 0 || mailbox.length > MAX_MAILBOX_LENGTH || /[\u0000-\u001f\u007f]/.test(mailbox)) return null;
  if (!/^[1-9]\d{0,9}$/.test(uidValidity) || Number(uidValidity) > MAX_UINT32) return null;
  if (!/^[1-9]\d{0,9}$/.test(uidText)) return null;
  const uid = Number(uidText);
  if (uid > MAX_UINT32) return null;
  const ref: ImapMessageRef = { mailbox, uidValidity, uid };
  // Canonical form only (no alternative encodings of the same reference).
  return encodeImapId(ref) === id ? ref : null;
}
