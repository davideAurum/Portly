/**
 * The local server panel (Pages build, hybrid mode): where this page load's data comes from, what
 * the local server controller found on this PC, and the next step — look for Portly, check
 * again, pair this browser, open Portly's own page, disconnect this browser or switch now — with
 * how to allow the browser's local network permission and what Portly on this PC adds. It is
 * the footer indicator's popover (`LocalServerStatus`) and a card in Settings → About.
 *
 * State and actions come from the local server store (`useLocalServer`, `localServerActions`).
 * {@link useDisplayedLocalServerStatus} keeps a background re-probe from flashing "Checking…".
 * Renders nothing while hybrid mode is off (status `disabled`: the server build, or a Pages build
 * without a local server).
 */
import { useState, type ReactNode } from 'react';
import { ArrowRightLeft, Link2, RefreshCw, Search, Unplug } from 'lucide-react';
import { localServerActions, useLocalServer } from '../localServer/store.ts';
import type { LocalServerInfo, LocalServerState, LocalServerStatus } from '../localServer/types.ts';
import { Badge, type BadgeTone } from '../ui/Badge.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/Dialog.tsx';
import { RelativeTime } from '../ui/RelativeTime.tsx';
import { FactList, SettingsCard } from '../ui/Section.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { toastError } from '../ui/toast.ts';
import { pendingSwitchText } from './StatusBanners.tsx';
import styles from './LocalServerPanel.module.css';

export interface LocalServerStatusView {
  /** Short label, e.g. "Not detected" (the footer indicator's text). */
  label: string;
  tone: BadgeTone;
}

const STATUS_VIEWS: Readonly<Record<LocalServerStatus, LocalServerStatusView>> = Object.freeze({
  disabled: { label: 'Off', tone: 'neutral' },
  framed: { label: 'Not used in a frame', tone: 'neutral' },
  idle: { label: 'Not checked', tone: 'neutral' },
  checking: { label: 'Checking…', tone: 'neutral' },
  absent: { label: 'Not detected', tone: 'neutral' },
  blocked: { label: 'Blocked by browser', tone: 'danger' },
  'waiting-permission': { label: 'Waiting for permission', tone: 'warning' },
  unpaired: { label: 'Found, not paired', tone: 'accent' },
  revoked: { label: 'Pairing removed', tone: 'warning' },
  'other-server': { label: 'Paired with another Portly', tone: 'warning' },
  incompatible: { label: 'Needs update', tone: 'warning' },
  connected: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting…', tone: 'warning' },
});

/** The label and tone of a status; `connected` names the server's version ("Connected · v0.1.0"). */
export function localServerStatusView(status: LocalServerStatus, server: LocalServerInfo | null): LocalServerStatusView {
  const view = STATUS_VIEWS[status];
  if (status === 'connected' && server !== null && server.version !== '') return { ...view, label: `${view.label} · v${server.version}` };
  return view;
}

/**
 * The status to show. A background re-probe (`checking` the user did not start) keeps showing the
 * last settled status, so nothing flashes "Checking…" every 30 s; a check the user started, or the
 * first one after this component mounted, shows "Checking…".
 */
export function useDisplayedLocalServerStatus(state: LocalServerState): LocalServerStatus {
  const [settled, setSettled] = useState<LocalServerStatus | null>(state.status === 'checking' ? null : state.status);
  // Adjusting state while rendering (React's pattern for following a changing value).
  if (state.status !== 'checking' && state.status !== settled) setSettled(state.status);
  return state.status === 'checking' && !state.manual && settled !== null ? settled : state.status;
}

/** What the Portly server adds over the copy in this browser. */
const SERVER_ADDS: readonly string[] = [
  'Calendar, mail and RSS feed widgets',
  'Google, Outlook.com, Yahoo, CalDAV and IMAP accounts',
  'Bookmark titles and icons fetched for you, and bookmark import from Chrome or Edge',
  'Search suggestions from Google, DuckDuckGo and Bing',
];

/** What the status means for this page load (the backend decides some of the wording). */
function describeStatus(status: LocalServerStatus, state: LocalServerState): ReactNode {
  const onServer = state.backend === 'server';
  switch (status) {
    case 'disabled':
      return null;
    case 'framed':
      return 'Inside a frame, Portly always uses the copy saved in this browser. Open Portly in its own tab to use Portly on this PC.';
    case 'idle':
      return state.permission === 'prompt'
        ? 'This site can use Portly running on this PC instead of the copy saved in this browser. When you look for it, your browser asks whether this site may reach apps on this device: choose Allow.'
        : 'This site can use Portly running on this PC instead of the copy saved in this browser.';
    case 'checking':
      return 'Looking for Portly on this PC…';
    case 'absent':
      return "Portly isn't running on this PC, or isn't installed here. This page uses the copy saved in this browser.";
    case 'blocked':
      return 'Your browser blocks this site from reaching apps on this PC, so this page uses the copy saved in this browser.';
    case 'waiting-permission':
      return 'Your browser is asking whether this site may reach apps on this PC. Choose Allow in its prompt next to the address bar.';
    case 'unpaired':
      return "Portly is running on this PC, but this browser isn't paired with it yet. Pairing is a one-time approval on Portly's own page.";
    case 'revoked':
      return 'Portly on this PC no longer accepts this browser: its pairing was removed there. Pair this browser again to use it.';
    case 'other-server':
      return 'A different Portly is running on this PC than the one this browser was paired with (for example after a reinstall). Pair this browser again to use it.';
    case 'incompatible':
      return "Portly on this PC and this site are versions that can't work together. Update Portly on this PC (or this site) so both are current, then check again.";
    case 'connected':
      return onServer
        ? "This page uses Portly on this PC: your settings, bookmarks, accounts, calendars, mail and feeds come from it. Accounts are connected on Portly's own page."
        : 'Portly on this PC is ready. This page switches to it.';
    case 'reconnecting':
      return "Portly on this PC stopped answering. This page shows the last saved data and reconnects when it's back; if it stays away, the page switches to the copy saved in this browser.";
  }
}

/** Statuses where a Portly server answered, so its own page can be opened. */
const SERVER_FOUND: ReadonlySet<LocalServerStatus> = new Set(['unpaired', 'revoked', 'other-server', 'incompatible', 'connected', 'reconnecting']);
const PAIRABLE: ReadonlySet<LocalServerStatus> = new Set(['unpaired', 'revoked', 'other-server']);

export interface DisconnectDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Confirms "Disconnect this browser" (the controller then reloads on the browser backend). */
export function DisconnectDialog({ open, onOpenChange }: DisconnectDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Disconnect this browser?"
      description="This browser forgets its pairing with Portly on this PC (and tells Portly to forget it too), and the page then uses the copy saved in this browser. To use Portly on this PC again, pair this browser again."
      confirmLabel="Disconnect"
      destructive
      onConfirm={async () => {
        try {
          await localServerActions.disconnect();
        } catch (error) {
          toastError(error, 'This browser could not be disconnected.');
          throw error;
        }
      }}
    />
  );
}

export interface LocalServerPanelProps {
  variant: 'popover' | 'card';
  /** The status to show (the footer indicator passes its own so both agree); default: this panel's. */
  status?: LocalServerStatus;
  /**
   * "Disconnect this browser" was chosen. The popover passes it (it closes first and its owner
   * confirms); without it the panel confirms itself.
   */
  onDisconnect?: () => void;
}

export function LocalServerPanel({ variant, status: shownStatus, onDisconnect }: LocalServerPanelProps) {
  const state = useLocalServer();
  const displayed = useDisplayedLocalServerStatus(state);
  const [confirming, setConfirming] = useState(false);
  const status = shownStatus ?? displayed;
  if (status === 'disabled') return null;

  const view = localServerStatusView(status, state.server);
  const badge = (
    <Badge tone={view.tone} dot>
      {view.label}
    </Badge>
  );
  const body = <PanelBody state={state} status={status} variant={variant} onDisconnect={onDisconnect ?? (() => setConfirming(true))} />;
  const dialog = onDisconnect === undefined ? <DisconnectDialog open={confirming} onOpenChange={setConfirming} /> : null;

  if (variant === 'card') {
    return (
      <>
        <SettingsCard
          id="local-server"
          title="Portly on this PC"
          description={
            state.backend === 'server'
              ? "This page's data comes from Portly running on this PC."
              : 'This site can use Portly running on this PC instead of the copy saved in this browser.'
          }
          actions={badge}
        >
          {body}
        </SettingsCard>
        {dialog}
      </>
    );
  }
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <p className={styles.title}>Portly on this PC</p>
        {badge}
      </div>
      {body}
      {dialog}
    </div>
  );
}

interface PanelBodyProps {
  state: LocalServerState;
  status: LocalServerStatus;
  variant: 'popover' | 'card';
  onDisconnect: () => void;
}

function PanelBody({ state, status, variant, onDisconnect }: PanelBodyProps) {
  const pending = state.pendingSwitch;
  const onServer = state.backend === 'server';
  const pairable = PAIRABLE.has(status);
  // The idle state's only action is looking; checking keeps the button (and its focus) in place.
  const canCheck = status !== 'framed' && !(status === 'connected' && onServer);
  const blocked = status === 'blocked' || state.permission === 'denied';

  const facts: { label: ReactNode; value: ReactNode }[] = [
    { label: "This page's data", value: onServer ? 'From Portly on this PC' : 'Saved in this browser' },
  ];
  if (state.server !== null && SERVER_FOUND.has(status)) facts.push({ label: 'Version', value: state.server.version });
  if (state.checkedAt !== null) facts.push({ label: 'Last checked', value: <RelativeTime date={state.checkedAt} /> });

  return (
    <div className={styles.body}>
      <p className={styles.text}>
        {status === 'checking' ? <Spinner size={14} className={styles.spinner} /> : null}
        {describeStatus(status, state)}
      </p>
      {blocked ? (
        <p className={styles.text}>
          To allow it, open this site's settings (the icon to the left of the address), set <strong>Local network access</strong>{' '}
          (called <strong>Apps on device</strong> in some versions) to <strong>Allow</strong>, then check again.
        </p>
      ) : null}
      {pending !== null ? <p className={styles.text}>{pendingSwitchText(pending)}</p> : null}
      {variant === 'card' ? (
        <FactList items={facts} />
      ) : (
        <dl className={styles.facts}>
          {facts.map((fact, index) => (
            <div key={index} className={styles.fact}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {status === 'framed' ? null : (
        <div className={styles.actions}>
          {pending !== null ? (
            <Button size="sm" variant="primary" icon={ArrowRightLeft} onClick={() => localServerActions.switchNow()}>
              Switch now
            </Button>
          ) : null}
          {pairable ? (
            <Button size="sm" variant={pending === null ? 'primary' : 'secondary'} icon={Link2} onClick={() => localServerActions.startPairing()}>
              Pair this browser
            </Button>
          ) : null}
          {canCheck ? (
            <Button
              size="sm"
              variant={status === 'idle' ? 'primary' : 'secondary'}
              icon={status === 'idle' ? Search : RefreshCw}
              // Unpaired, the permission may not be granted yet: looking is the user's gesture.
              onClick={() => (state.paired ? localServerActions.checkNow() : localServerActions.lookForServer())}
            >
              {status === 'idle' ? 'Look for Portly on this PC' : 'Check again'}
            </Button>
          ) : null}
          {state.paired ? (
            <Button size="sm" variant="ghost" icon={Unplug} onClick={onDisconnect}>
              Disconnect this browser
            </Button>
          ) : null}
        </div>
      )}
      {onServer ? null : <ServerAdds collapsible={variant === 'popover'} />}
    </div>
  );
}

/** What Portly on this PC adds (a disclosure in the popover, a list in the card). */
function ServerAdds({ collapsible }: { collapsible: boolean }) {
  const list = (
    <>
      <ul className={styles.adds}>
        {SERVER_ADDS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className={styles.note}>
        Portly on this PC keeps its own settings and bookmarks. The copy saved in this browser stays as it is, for when Portly isn't
        running.
      </p>
    </>
  );
  if (collapsible) {
    return (
      <details className={styles.details}>
        <summary>What Portly on this PC adds</summary>
        {list}
      </details>
    );
  }
  return (
    <div className={styles.addsSection}>
      <p className={styles.addsTitle}>What Portly on this PC adds</p>
      {list}
    </div>
  );
}
