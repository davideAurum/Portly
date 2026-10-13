/**
 * Settings layout (§10.5): section navigation (hash links `#/settings/<section>`) and the lazily
 * loaded section. The heading receives focus on section changes so keyboard and screen-reader
 * users land on the new content. A section this page load does not show (Calendars on the
 * in-browser backend) answers its URL with `ServerOnlyNotice`. Diagnostics carries a "Verbose"
 * badge while the server logs verbosely (`VerboseNavBadge`).
 */
import { Suspense, useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { routeHref } from '../app/router.ts';
import { VerboseNavBadge } from '../diagnostics/ui/VerboseNavBadge.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ServerOnlyNotice } from '../ui/ServerOnlyNotice.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { getSettingsSection, isSettingsSectionAvailable, settingsSections, type SettingsSectionId } from './nav.ts';
import styles from '../styles/settings.module.css';

export interface SettingsShellProps {
  section: SettingsSectionId;
}

export function SettingsShell({ section }: SettingsShellProps) {
  const current = getSettingsSection(section);
  const Section = current.Component;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const navRef = useRef<HTMLElement>(null);

  // On narrow screens the nav is a horizontal strip: keep the current section's link in view.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    const navBox = nav.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    if (box.left < navBox.left || box.right > navBox.right) {
      nav.scrollLeft += box.left - navBox.left - (navBox.width - box.width) / 2;
    }
  }, [section]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: false });
  }, [section]);

  return (
    <div className={styles.shell}>
      <nav ref={navRef} className={styles.nav} aria-label="Settings sections">
        <a className={styles.back} href={routeHref({ name: 'home' })}>
          <ArrowLeft aria-hidden="true" className={styles.navIcon} />
          <span>Back to dashboard</span>
        </a>
        <ul className={styles.navList}>
          {settingsSections().map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <a
                className={styles.navLink}
                href={routeHref({ name: 'settings', section: id })}
                aria-current={id === section ? 'page' : undefined}
              >
                <Icon aria-hidden="true" className={styles.navIcon} />
                <span>{label}</span>
                {id === 'diagnostics' ? <VerboseNavBadge /> : null}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <section className={styles.content} aria-labelledby="settings-heading">
        <h1 id="settings-heading" ref={headingRef} tabIndex={-1} className={styles.heading}>
          {current.label}
        </h1>
        {isSettingsSectionAvailable(section) ? (
          <ErrorBoundary
            key={section}
            fallback={() => <EmptyState title="This section failed to load" body="Reload the page to try again." />}
          >
            <Suspense fallback={<SkeletonLines lines={5} />}>
              <Section />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <ServerOnlyNotice feature={current.label} icon={current.icon} />
        )}
      </section>
    </div>
  );
}
