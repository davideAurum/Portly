/**
 * Fallback bookmark title from a URL ("Netflix" for netflix.com), copied from
 * web/src/widgets/launchpad/BookmarkDialog.tsx so the static backend's site-meta substitute does
 * not import a React module. Keep the two copies identical (siteName.test.ts covers both).
 */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Second-level labels under which a country code keeps its registrable names (bbc.co.uk). */
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'gob', 'ne', 'or']);

/**
 * "Netflix" for netflix.com (the site's name as a fallback title until, or unless, the page's own
 * title arrives); the host itself for IP addresses and single-label names.
 */
export function siteName(url: string): string {
  const host = hostOf(url);
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  let index = labels.length - 2;
  if (index > 0 && labels[labels.length - 1]!.length === 2 && GENERIC_SECOND_LEVEL.has(labels[index]!)) index--;
  const label = labels[index] ?? host;
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}
