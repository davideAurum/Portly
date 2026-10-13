/**
 * Windows time-zone ids ↔ IANA (§8 Recurrence): a bundled copy of CLDR's `windowsZones.xml`
 * (see `data/windowsZones.json` for the source commit and versions). Used for ICS/CalDAV TZIDs
 * without a VTIMEZONE (Outlook exports use Windows ids such as "W. Europe Standard Time") and
 * for Microsoft Graph `originalStartTimeZone` / event writes.
 */
import fs from 'node:fs';
import { isKnownTimeZone } from './time.ts';

interface WindowsZonesData {
  /** Windows id → golden IANA zone (territory "001"). */
  windows: Record<string, string>;
  /** IANA id → Windows id. */
  ianaToWindows: Record<string, string>;
}

function load(): WindowsZonesData {
  try {
    const text = fs.readFileSync(new URL('./data/windowsZones.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text) as Partial<WindowsZonesData>;
    const windows = parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {};
    const ianaToWindows = parsed.ianaToWindows && typeof parsed.ianaToWindows === 'object' ? parsed.ianaToWindows : {};
    return { windows, ianaToWindows };
  } catch {
    return { windows: {}, ianaToWindows: {} };
  }
}

const DATA = load();
const WINDOWS = new Map(Object.entries(DATA.windows));
const WINDOWS_LOWER = new Map(Object.entries(DATA.windows).map(([k, v]) => [k.toLowerCase(), v]));
const IANA_TO_WINDOWS = new Map(Object.entries(DATA.ianaToWindows));

/** Number of Windows ids in the bundled table (tests / diagnostics). */
export const WINDOWS_ZONE_COUNT = WINDOWS.size;

/** IANA zone for a Windows zone id (case-insensitive), or null. */
export function windowsToIana(name: string): string | null {
  const trimmed = name.trim();
  return WINDOWS.get(trimmed) ?? WINDOWS_LOWER.get(trimmed.toLowerCase()) ?? null;
}

/** The runtime's canonical id for an IANA zone or alias (`Asia/Kolkata` → `Asia/Calcutta` in ICU), or null. */
function canonicalZone(tz: string): string | null {
  if (!isKnownTimeZone(tz)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Windows zone id for an IANA zone (or alias), or null. CLDR lists the legacy ids (`Asia/Calcutta`,
 * `Europe/Kiev`) while browsers report the current ones (`Asia/Kolkata`, `Europe/Kyiv`): unknown
 * names are retried with the runtime's canonical id.
 */
export function ianaToWindows(tz: string): string | null {
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/GMT') return 'UTC';
  const direct = IANA_TO_WINDOWS.get(tz);
  if (direct) return direct;
  const canonical = canonicalZone(tz);
  return (canonical && IANA_TO_WINDOWS.get(canonical)) ?? null;
}

const IANA_SUFFIX = /((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/;

/**
 * Resolves a TZID as found in calendar data to an IANA zone the runtime knows: an IANA id (or
 * alias), a Windows id via CLDR, or an IANA id embedded in a vendor prefix
 * (`/mozilla.org/20050126_1/Europe/Berlin`). Returns null when nothing matches (floating).
 */
export function resolveTimeZoneName(tzid: string | null | undefined): string | null {
  if (typeof tzid !== 'string') return null;
  const trimmed = tzid.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed === '' || trimmed.length > 200) return null;
  if (trimmed === 'Z') return 'UTC';
  if (isKnownTimeZone(trimmed) && !/^[+-]/.test(trimmed)) return trimmed;
  const windows = windowsToIana(trimmed);
  if (windows && isKnownTimeZone(windows)) return windows;
  const embedded = IANA_SUFFIX.exec(trimmed)?.[1];
  if (embedded && isKnownTimeZone(embedded)) return embedded;
  return null;
}
