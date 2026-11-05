/**
 * Orders Portly's versions, so the Pages site can say when the server it uses is older than the
 * site (ARCHITECTURE §16): the site moves with each publish, the server when that PC updates.
 * Versions are semver, so `0.2.0-alpha.10` is newer than `0.2.0-alpha.9` and `0.2.0` is newer than
 * both, which comparing them as plain strings gets wrong.
 *
 * The server's version is untrusted input (§16): anything but a short, well-formed version reads
 * as `null`, and {@link isServerBehind} then says no, so such text never reaches the page.
 */

/** The longest version read: the same cap as the page's version in a diagnostics report. */
const MAX_VERSION_LENGTH = 40;
/** What a server reports when it could not read its own version (`appVersion()`). */
const UNKNOWN_SERVER_VERSION = '0.0.0';

const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC = /^[0-9]+$/;

/** A prerelease identifier: numbers compare as numbers, words in ASCII order. */
type Identifier = number | string;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Empty for a release. */
  prerelease: readonly Identifier[];
}

/** A whole number without leading zeros that stays exact as a JavaScript number, else null. */
function readNumber(text: string): number | null {
  if (text.length > 1 && text.startsWith('0')) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function readPrerelease(text: string): Identifier[] | null {
  const identifiers: Identifier[] = [];
  for (const part of text.split('.')) {
    const identifier = NUMERIC.test(part) ? readNumber(part) : part;
    if (identifier === null) return null;
    identifiers.push(identifier);
  }
  return identifiers;
}

function parseVersion(text: string): ParsedVersion | null {
  if (text.length > MAX_VERSION_LENGTH) return null;
  const [, majorText = '', minorText = '', patchText = '', prereleaseText] = VERSION.exec(text) ?? [];
  const major = readNumber(majorText);
  const minor = readNumber(minorText);
  const patch = readNumber(patchText);
  const prerelease = prereleaseText === undefined ? [] : readPrerelease(prereleaseText);
  if (majorText === '' || major === null || minor === null || patch === null || prerelease === null) return null;
  return { major, minor, patch, prerelease };
}

function compareIdentifiers(a: Identifier, b: Identifier): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Numbers sort before words.
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function comparePrereleases(a: readonly Identifier[], b: readonly Identifier[]): number {
  // A release is newer than its own prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (const [index, identifier] of a.entries()) {
    const other = b[index];
    if (other === undefined) return 1;
    const order = compareIdentifiers(identifier, other);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/**
 * Below zero when `a` is older than `b`, above zero when newer, zero when they rank the same
 * (build metadata after a `+` does not count); null when either can't be read.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch || comparePrereleases(left.prerelease, right.prerelease);
}

/** True only when both versions can be read and the server's is older than the site's. */
export function isServerBehind(serverVersion: string, siteVersion: string): boolean {
  if (serverVersion === UNKNOWN_SERVER_VERSION) return false;
  const order = compareVersions(serverVersion, siteVersion);
  return order !== null && order < 0;
}
