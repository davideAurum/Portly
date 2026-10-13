/**
 * Private (local-network) addresses (§8 Generic CalDAV `insecureLan`): RFC 1918, loopback,
 * link-local, CGNAT and IPv6 ULA/link-local, including IPv4-mapped IPv6. Plain `http` to a
 * CalDAV server is allowed only while its host is (or resolves only to) such addresses.
 */
import { BlockList, isIP } from 'node:net';

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT / overlay VPNs
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True for RFC 1918, loopback, link-local, CGNAT and IPv6 ULA/link-local addresses (incl. IPv4-mapped). */
export function isPrivateAddress(address: string): boolean {
  const unbracketed = address.replace(/^\[|\]$/g, '');
  // Drop an IPv6 zone id (`fe80::1%eth0`) by index, not with a backtracking `/%.*$/`.
  const zone = unbracketed.indexOf('%');
  const bare = zone === -1 ? unbracketed : unbracketed.slice(0, zone);
  const mapped = MAPPED_V4.exec(bare);
  if (mapped?.[1]) return PRIVATE.check(mapped[1], 'ipv4');
  const family = isIP(bare);
  if (family === 4) return PRIVATE.check(bare, 'ipv4');
  if (family === 6) return PRIVATE.check(bare, 'ipv6');
  return false;
}
