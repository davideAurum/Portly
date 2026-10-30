/**
 * The Pages site's connect page (`#/connect`, Pages build with hybrid mode): connects this browser
 * to Portly on the main PC through its Tailscale address, so another PC uses the same site as the
 * main one (ARCHITECTURE §20; `localServer/remote.ts`).
 *
 * 1. The address, typed once per browser (prefilled with the last one it connected to): checked
 *    with `checkRemoteServer`, which also lets the browser ask for its local network permission.
 * 2. The connect screen (`ConnectPage`) with the main PC's requests: a name, a code to compare,
 *    the wait for Approve on the main PC. Approved, the connection is saved and the page reloads
 *    on `#/`, where the next page load runs on the main PC's Portly.
 *
 * A browser already paired with Portly on this PC, or already connected, is told so instead: one
 * server per browser.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, Globe, Link2, Monitor } from 'lucide-react';
import { useLocalServer } from '../localServer/store.ts';
import { REMOTE_SERVER_HOST_SUFFIX, parseRemoteServerAddress } from '../localServer/origin.ts';
import { browserLocalStorage, browserSessionStorage, readItem, type StorageLike } from '../localServer/pairing.ts';
import { checkRemoteServer, createRemoteConnectClient, remoteAddressKey, type RemoteCheckResult } from '../localServer/remote.ts';
import type { FetchLike } from '../localServer/probe.ts';
import { Banner } from '../ui/Banner.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { Input } from '../ui/Input.tsx';
import { ConnectPage, ConnectPanel } from './ConnectPage.tsx';
import styles from './PairPage.module.css';

export interface RemoteConnectPageProps {
  /** Overrides for tests; the defaults are the browser's. */
  fetch?: FetchLike;
  local?: StorageLike | null;
  session?: StorageLike | null;
  now?: () => number;
  /** Leaves for the dashboard, which then loads on the main PC's Portly. */
  reload?: () => void;
  pollMs?: number;
}

/** Back to the dashboard, as a fresh page load (it picks the backend before its first render). */
function reloadHome(): void {
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/`);
  window.location.reload();
}

const CHECK_MESSAGES: Readonly<Record<Exclude<RemoteCheckResult['kind'], 'ok'>, string>> = Object.freeze({
  unreachable:
    'Nothing at that address answered this site. Check that Tailscale runs on this PC, signed in to the same tailnet as the main PC; that Portly runs on the main PC with this site as its Pages site; and that this browser may reach devices on your network (if it blocked that, open this site’s settings next to the address bar and allow Local network access).',
  'not-portly': 'Something answered at that address, but it isn’t Portly. Check the address in Settings → Devices on the main PC.',
  incompatible: 'Portly on the main PC and this site are versions that can’t work together. Update Portly on the main PC, then try again.',
  'not-remote':
    'Portly on the main PC took this request as the main PC’s own: its Tailscale Serve forwards to Portly’s main port instead of its port for other PCs. On the main PC run tailscale serve --bg 5758, then try again.',
});

type Stage = { kind: 'address'; error: string | null } | { kind: 'checking' } | { kind: 'connect'; origin: string; instanceId: string };

export function RemoteConnectPage({ fetch: fetchImpl, local, session, now, reload = reloadHome, pollMs }: RemoteConnectPageProps = {}) {
  const state = useLocalServer();
  const localStorage = local === undefined ? browserLocalStorage() : local;
  const sessionStorage = session === undefined ? browserSessionStorage() : session;
  const doFetch = useMemo<FetchLike>(() => fetchImpl ?? ((input, init) => fetch(input, init)), [fetchImpl]);
  const [address, setAddress] = useState(() => readItem(localStorage, remoteAddressKey()) ?? '');
  const [stage, setStage] = useState<Stage>({ kind: 'address', error: null });

  const client = useMemo(
    () =>
      stage.kind === 'connect'
        ? createRemoteConnectClient({ origin: stage.origin, instanceId: stage.instanceId, fetch: doFetch, local: localStorage, session: sessionStorage, now: now ?? (() => Date.now()) })
        : null,
    // The client belongs to the address being connected; storage and clock are per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stage, doFetch],
  );

  if (state.status === 'disabled' || state.status === 'framed') {
    return (
      <ConnectPanel icon={Globe} title="Connect to Portly on your main PC">
        <p className={styles.text}>
          {state.status === 'framed'
            ? 'Inside a frame this site uses only the copy saved in this browser. Open it in its own tab to connect.'
            : 'This copy of the site cannot use a Portly server.'}
        </p>
        <div className={styles.actions}>
          <HomeButton />
        </div>
      </ConnectPanel>
    );
  }

  if (state.paired && stage.kind !== 'connect') {
    const remote = state.remoteOrigin ?? null;
    return (
      <ConnectPanel icon={remote !== null ? Link2 : Monitor} title={remote !== null ? 'Already connected' : 'This browser uses Portly on this PC'}>
        <p className={styles.text}>
          {remote !== null ? (
            <>
              This browser is connected to Portly at <code className={styles.code}>{new URL(remote).hostname}</code>.
            </>
          ) : (
            'This browser is paired with Portly running on this PC. A browser uses one Portly: to use the main PC’s instead, disconnect this one first (the Portly status in the footer, then Disconnect this browser).'
          )}
        </p>
        <div className={styles.actions}>
          <HomeButton />
        </div>
      </ConnectPanel>
    );
  }

  if (stage.kind === 'connect' && client !== null) {
    return <ConnectPage client={client} reload={reload} pollMs={pollMs} onBack={() => setStage({ kind: 'address', error: null })} />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const origin = parseRemoteServerAddress(address);
    if (origin === null) {
      setStage({ kind: 'address', error: `Enter the address Settings → Devices shows on the main PC, like https://<pc>.<tailnet>${REMOTE_SERVER_HOST_SUFFIX}.` });
      return;
    }
    setStage({ kind: 'checking' });
    let result: RemoteCheckResult;
    try {
      result = await checkRemoteServer(origin, { fetch: doFetch });
    } catch {
      result = { kind: 'unreachable' };
    }
    if (result.kind === 'ok') setStage({ kind: 'connect', origin, instanceId: result.instanceId });
    else setStage({ kind: 'address', error: CHECK_MESSAGES[result.kind] });
  };

  const checking = stage.kind === 'checking';
  return (
    <ConnectPanel icon={Globe} title="Connect to Portly on your main PC">
      <p className={styles.text}>
        Portly runs on one PC, the main PC. This PC can use it through this same site: enter the main PC’s Tailscale address once, then
        approve this browser on the main PC. Nothing of Portly needs to be installed here, but Tailscale does, signed in to the same tailnet.
      </p>
      <form onSubmit={(event) => void submit(event)} className={styles.form}>
        <Field label="Address of Portly on the main PC" help="Settings → Devices on the main PC shows it.">
          <Input
            value={address}
            placeholder={`https://<pc>.<tailnet>${REMOTE_SERVER_HOST_SUFFIX}`}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setAddress(event.currentTarget.value)}
            required
          />
        </Field>
        {checking ? (
          <p className={styles.text}>If your browser asks whether this site may reach devices on your network, choose Allow.</p>
        ) : null}
        {stage.kind === 'address' && stage.error !== null ? (
          <Banner tone="danger" title="This PC could not reach Portly there">
            {stage.error}
          </Banner>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" icon={Link2} loading={checking} disabled={address.trim() === ''}>
            Continue
          </Button>
          <HomeButton variant="ghost" />
        </div>
      </form>
    </ConnectPanel>
  );
}

function HomeButton({ variant = 'secondary' }: { variant?: 'secondary' | 'ghost' }) {
  return (
    <Button variant={variant} icon={ArrowLeft} onClick={() => (window.location.hash = '#/')}>
      Back to Portly
    </Button>
  );
}
