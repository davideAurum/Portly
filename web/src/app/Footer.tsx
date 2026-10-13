/**
 * Page footer: quick links (dashboard, settings, about, shortcuts), the public privacy policy and
 * terms, a contact link, copyright, and the app version with the date it was last updated. The
 * `serverStatus` slot ends the version line: the Pages build puts its local server indicator there
 * (`LocalServerStatus`); the slot hides itself, separator included, when that renders nothing.
 */
import type { ReactNode } from 'react';
import { routeHref } from './router.ts';
import styles from './Footer.module.css';

export const APP_UPDATED: string = __APP_UPDATED__;

/**
 * Public pages Google's OAuth consent screen links to (the `site/` folder, published separately to
 * the repository still named homebase-site).
 */
export const SITE_URL = 'https://davideaurum.github.io/homebase-site/';
export const CONTACT_URL = 'https://github.com/davideAurum';

/**
 * `2026-10-11T08:12:34-05:00` → `Oct 11, 2026, 8:12 AM` in the viewer's time zone (or `timeZone`).
 * A bare `2026-10-11` is read as a calendar date (no time zone shift) → `Oct 11, 2026`.
 */
export function formatUpdated(iso: string, timeZone?: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number) as [number, number, number, number];
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const ms = Date.parse(iso);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || !Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
}

export interface FooterProps {
  version: string;
  updated?: string;
  onShowShortcuts: () => void;
  /** Shown after the version line (the Pages build's local server indicator). */
  serverStatus?: ReactNode;
}

export function Footer({ version, updated = APP_UPDATED, onShowShortcuts, serverStatus }: FooterProps) {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <nav className={styles.links} aria-label="Footer">
          <a href={routeHref({ name: 'home' })}>Dashboard</a>
          <a href={routeHref({ name: 'settings', section: 'general' })}>Settings</a>
          <a href={routeHref({ name: 'settings', section: 'about' })}>About</a>
          <button type="button" className={styles.linkButton} onClick={onShowShortcuts}>
            Shortcuts
          </button>
          <a href={`${SITE_URL}privacy.html`} target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          <a href={`${SITE_URL}terms.html`} target="_blank" rel="noopener noreferrer">
            Terms
          </a>
          <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
            Contact
          </a>
        </nav>
        <p className={styles.meta}>
          <span>© {updated.slice(0, 4)} Portly</span>
          <span aria-hidden="true">·</span>
          <span>Version {version}</span>
          <span aria-hidden="true">·</span>
          <span>
            Last updated <time dateTime={updated}>{formatUpdated(updated)}</time>
          </span>
          {serverStatus != null ? <span className={styles.serverStatus}>{serverStatus}</span> : null}
        </p>
      </div>
    </footer>
  );
}
