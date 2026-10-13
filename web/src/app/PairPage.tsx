/**
 * `#/pair?nonce=…` (hybrid mode). On Portly's own page this is where a browser is paired
 * with the Pages site: the Pages site sends the tab here with a one-time nonce, the user approves,
 * the server creates the pairing, and the tab goes back to the configured Pages address with the
 * token in the fragment (`api/pairing.ts`). Before that, the page names the *origin* it is about to
 * trust (every page under it gets the same access in this browser) and what that access covers.
 *
 * Approve is armed only after the page has been visible and focused for a second in a row, and
 * disarmed whenever the window loses focus or is hidden, so a click or key press aimed at whatever
 * was in front a moment ago cannot approve. In the Pages build the route only says that pairing
 * happens on Portly's own page, with a link to it.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowLeft, Ban, Check, CircleCheck, Link2, Settings2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { PairingRedirectError, useApprovePairing, usePairings } from '../api/pairing.ts';
import { getCapabilities } from '../capabilities.ts';
import { safeHref } from '../lib/openUrl.ts';
import { Banner } from '../ui/Banner.tsx';
import { Button } from '../ui/Button.tsx';
import { ErrorState } from '../ui/ErrorState.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { errorMessage } from '../ui/toast.ts';
import { navigate, routeHref } from './router.ts';
import styles from './PairPage.module.css';

/** How long the page must have been visible and focused before Approve works. */
export const APPROVE_ARM_DELAY_MS = 1000;

/**
 * True once the document has been visible and focused for `delayMs` without interruption; false
 * again as soon as the window loses focus or the tab is hidden (the wait then starts over when
 * attention returns). Checked on every window focus/blur and visibility change; an event that
 * leaves the page visible and focused (focus moving within it) changes nothing.
 */
export function useAttendedFor(delayMs: number): boolean {
  const [attended, setAttended] = useState(false);
  useEffect(() => {
    let phase: 'away' | 'waiting' | 'armed' = 'away';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        clearTimeout(timer);
        timer = undefined;
        phase = 'away';
        setAttended(false);
      } else if (phase === 'away') {
        phase = 'waiting';
        timer = setTimeout(() => {
          timer = undefined;
          phase = 'armed';
          setAttended(true);
        }, delayMs);
      }
    };
    setAttended(false);
    check();
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [delayMs]);
  return attended;
}

export interface PairPageProps {
  /** The request's nonce, or null when the link has none or a malformed one. */
  nonce: string | null;
}

export function PairPage({ nonce }: PairPageProps) {
  return getCapabilities().pagesBuild ? <PagesBuildNote /> : <PairRequest nonce={nonce} />;
}

/**
 * How to turn pairing on: the server reads `PORTLY_PAGES_URL` at start-up. Shared with the
 * Paired browsers card in Settings → About.
 */
export function PairingSetupSteps() {
  return (
    <>
      <ol className={styles.steps}>
        <li>
          Set the Windows user environment variable <code className={styles.code}>PORTLY_PAGES_URL</code> to your Pages site’s address,
          for example <code className={styles.code}>https://&lt;user&gt;.github.io/</code>.
        </li>
        <li>
          Re-run <code className={styles.code}>scripts/install-autostart.ps1</code> from your Portly folder (add{' '}
          <code className={styles.code}>-Trigger Logon</code> if you use Logon mode: the installer replaces the task, and its default is Browser
          mode), or sign out of Windows and back in, so Portly starts with it.
        </li>
        <li>
          Open your Pages site and choose <strong>Pair this browser</strong>.
        </li>
      </ol>
      <p className={styles.text}>
        The step-by-step guide is <code className={styles.code}>docs/setup/pages-local-server.md</code> in the Portly folder.
      </p>
    </>
  );
}

/** The configured Pages address as the browser will navigate to it, or null when unset or unusable. */
function usablePagesUrl(raw: string | null): string | null {
  const href = safeHref(raw, { allowAppRoutes: false });
  return href !== undefined && href.endsWith('/') ? href : null;
}

function PairPanel({ icon: Icon, tone, title, children }: { icon: LucideIcon; tone?: 'warning'; title: ReactNode; children: ReactNode }) {
  const titleId = useId();
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby={titleId}>
        <header className={styles.header}>
          <span className={styles.icon} data-tone={tone} aria-hidden="true">
            <Icon />
          </span>
          <h1 id={titleId} className={styles.title}>
            {title}
          </h1>
        </header>
        {children}
      </section>
    </main>
  );
}

function BackToDashboard() {
  return (
    <a className={styles.backLink} href={routeHref({ name: 'home' })}>
      <ArrowLeft aria-hidden="true" />
      Back to the dashboard
    </a>
  );
}

function PagesBuildNote() {
  return (
    <PairPanel icon={Link2} title="Pairing happens on Portly’s own page">
      <p className={styles.text}>
        This site pairs with Portly on this PC through Portly’s own page, which asks you to approve. To start, choose{' '}
        <strong>Pair this browser</strong> in the Portly status at the bottom of the dashboard.
      </p>
      <div className={styles.actions}>
        <BackToDashboard />
      </div>
    </PairPanel>
  );
}

function PairRequest({ nonce }: PairPageProps) {
  const pairings = usePairings();

  if (pairings.data === undefined) {
    return (
      <PairPanel icon={Link2} title="Pair a browser with Portly">
        {pairings.isError ? <ErrorState error={pairings.error} onRetry={() => void pairings.refetch()} /> : <SkeletonLines lines={4} />}
        <div className={styles.actions}>
          <BackToDashboard />
        </div>
      </PairPanel>
    );
  }

  const pagesUrl = usablePagesUrl(pairings.data.pagesUrl);
  if (pagesUrl === null) {
    return (
      <PairPanel icon={Settings2} title="Pairing is turned off">
        <p className={styles.text}>
          Portly on this PC doesn’t know your Pages site’s address yet, so no browser can be paired with it.
        </p>
        <PairingSetupSteps />
        <div className={styles.actions}>
          <BackToDashboard />
        </div>
      </PairPanel>
    );
  }

  if (nonce === null) {
    return (
      <PairPanel icon={TriangleAlert} tone="warning" title="This pairing link doesn’t work">
        <p className={styles.text}>
          The link is incomplete or was changed, so nothing was paired. Start again from your Pages site: choose{' '}
          <strong>Pair this browser</strong> in the Portly status at the bottom of the dashboard.
        </p>
        <div className={styles.actions}>
          <BackToDashboard />
        </div>
      </PairPanel>
    );
  }

  return <PairApproval nonce={nonce} pagesUrl={pagesUrl} />;
}

const CAN: readonly string[] = [
  'See and change your dashboards, settings, bookmarks and uploads',
  'Use your calendars, mail, Todoist tasks, weather and feeds',
  'Rename or remove accounts that are already connected',
];

const CANNOT: readonly string[] = [
  'Connect accounts or set up OAuth clients',
  'Reset the credential vault',
  'Pair or unpair browsers',
  'See where Portly keeps its files on this PC',
];

function PairApproval({ nonce, pagesUrl }: { nonce: string; pagesUrl: string }) {
  const armed = useAttendedFor(APPROVE_ARM_DELAY_MS);
  const approve = useApprovePairing();
  const origin = new URL(pagesUrl).origin;
  // Success means the tab is already on its way back to the Pages site.
  const busy = approve.isPending || approve.isSuccess;

  return (
    <PairPanel icon={Link2} title="Allow this site to use Portly on this PC?">
      <p className={styles.origin}>{origin}</p>
      <p className={styles.text}>
        A page asked to pair this browser with your Pages site at <strong>{pagesUrl}</strong>. Approve only if you just chose{' '}
        <strong>Pair this browser</strong> there.
      </p>
      <Banner tone="warning" title={`Every page on ${origin} gets this access`}>
        Browsers keep data per site, not per page: any page under this address in this browser can use the pairing, not only your Pages site
        (for example another project published at {origin}/&lt;name&gt;/).
      </Banner>
      <div className={styles.scope}>
        <div>
          <h2 className={styles.scopeTitle}>It will be able to</h2>
          <ul className={styles.scopeList} data-kind="can">
            {CAN.map((item) => (
              <li key={item}>
                <CircleCheck aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={styles.scopeTitle}>It won’t be able to</h2>
          <ul className={styles.scopeList} data-kind="cannot">
            {CANNOT.map((item) => (
              <li key={item}>
                <Ban aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {approve.isError ? (
        <Banner tone="danger" title="This browser was not paired">
          {approve.error instanceof PairingRedirectError ? approve.error.message : errorMessage(approve.error, 'Portly could not pair this browser.')}
        </Banner>
      ) : null}
      <div className={styles.actions}>
        <p className={styles.actionsNote}>
          You can unpair it at any time in <a href={routeHref({ name: 'settings', section: 'about' })}>Settings → About</a> on this page.
        </p>
        <Button variant="ghost" disabled={busy} onClick={() => navigate({ name: 'home' }, { replace: true })}>
          Cancel
        </Button>
        <Button variant="primary" icon={Check} disabled={!armed} loading={busy} onClick={() => approve.mutate({ nonce, pagesUrl })}>
          Approve
        </Button>
      </div>
    </PairPanel>
  );
}
