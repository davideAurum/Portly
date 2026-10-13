/**
 * Private-address check for generic CalDAV servers (§8): plain `http` is accepted only when the
 * user ticked "insecure LAN" and the host is (or resolves only to) a private/loopback address.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../../security/private-address.ts';

export { isPrivateAddress } from '../../security/private-address.ts';

export interface LookupAddress {
  address: string;
  family: number;
}

/** `dns.promises.lookup(host, {all: true})` shape (injectable for tests). */
export type LookupFn = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

export const defaultLookup: LookupFn = (hostname, options) => dnsLookup(hostname, options);

const LOOKUP_TIMEOUT_MS = 5_000;

/** True when `hostname` is a private IP literal or resolves only to private addresses. */
export async function hostIsPrivate(hostname: string, lookup: LookupFn = defaultLookup): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return isPrivateAddress(bare);
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookup(bare, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('lookup timed out')), LOOKUP_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return addresses.length > 0 && addresses.every((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
