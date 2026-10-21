/**
 * The connect screen another PC sees instead of the app until it is approved (ARCHITECTURE §4.2
 * remote branch; shared/src/devices.ts). Rendered on its own by `main.tsx` when the server took
 * this page load as another PC's and `GET /api/device` says it is not connected.
 *
 * 1. On load it asks `GET /api/devices/requests/current`: a request made earlier in this browser
 *    (the enrollment cookie) is picked up where it was; none → the form.
 * 2. The form asks for a name for this PC ("Laptop") and posts the request; the answer is a short
 *    code to compare by eye.
 * 3. While waiting it polls every {@link POLL_MS} (less often while the tab is hidden): `pending`
 *    keeps waiting; `approved` means the device cookie is now set, so the page reloads into the
 *    app; `denied`, `expired` or a request the server no longer knows show why and offer to ask
 *    again. A server that cannot be reached is reported with a Retry.
 *
 * `MisroutedPage` is shown instead when the server answered a page on a non-loopback address as
 * this PC's own: the proxy points at the main port, not the remote one, and nothing here can be
 * trusted until that is fixed (`app/remoteClient.ts`).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Ban, Clock, Laptop, RefreshCw, Send, TriangleAlert, type LucideIcon } from 'lucide-react';
import { DEVICE_LABEL_MAX, type DeviceRequestStatusResponse } from '@portly/shared';
import { createDeviceRequest, fetchDeviceRequestStatus } from '../api/devices.ts';
import { isApiError } from '../api/client.ts';
import { Banner } from '../ui/Banner.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { Input } from '../ui/Input.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { errorMessage } from '../ui/toast.ts';
import styles from './PairPage.module.css';

/** How often the waiting page asks whether it was approved, and while the tab is hidden. */
export const POLL_MS = 2_000;
export const HIDDEN_POLL_MS = 10_000;

export interface ConnectPageDeps {
  /** Reloads the page once the device cookie is set (default: `window.location.reload()`). */
  reload?: () => void;
  /** The name offered in the form (default: "This PC"). */
  defaultLabel?: string;
  /** How often to ask while waiting (default {@link POLL_MS}; tests shorten it). */
  pollMs?: number;
}

type State =
  | { kind: 'checking' }
  | { kind: 'ask'; error: string | null }
  | { kind: 'waiting'; code: string; expiresAt: string }
  | { kind: 'approved' }
  | { kind: 'ended'; why: 'denied' | 'expired' | 'gone' }
  | { kind: 'unreachable'; message: string; retry: () => void };

function Panel({ icon: Icon, tone, title, children }: { icon: LucideIcon; tone?: 'warning'; title: ReactNode; children: ReactNode }) {
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

/** What a poll answer means for the page. */
function stateOf(status: DeviceRequestStatusResponse | null): State {
  if (status === null) return { kind: 'ask', error: null };
  switch (status.status) {
    case 'pending':
      return { kind: 'waiting', code: status.code, expiresAt: status.expiresAt };
    case 'approved':
      return { kind: 'approved' };
    case 'denied':
      return { kind: 'ended', why: 'denied' };
    default:
      return { kind: 'ended', why: 'expired' };
  }
}

export function ConnectPage({ reload = () => window.location.reload(), defaultLabel = 'This PC', pollMs = POLL_MS }: ConnectPageDeps = {}) {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [label, setLabel] = useState(defaultLabel);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  const reloadOnce = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One poll: the answer decides the next state (returned, so the loop knows whether to go on
  // before React has committed it); a server that cannot be reached offers Retry.
  const poll = async (signal?: AbortSignal): Promise<State['kind']> => {
    try {
      const status = await fetchDeviceRequestStatus(signal);
      if (!mounted.current) return 'checking';
      const next = stateOf(status);
      // A request the server no longer knows after we were waiting: say so rather than show the form again.
      setState((current) => (next.kind === 'ask' && current.kind === 'waiting' ? { kind: 'ended', why: 'gone' } : next));
      return next.kind;
    } catch (error) {
      if (!mounted.current || (error instanceof DOMException && error.name === 'AbortError')) return 'checking';
      setState({ kind: 'unreachable', message: errorMessage(error, 'Portly could not be reached.'), retry: () => void poll() });
      return 'unreachable';
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void poll(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, []);

  // Keep asking while waiting: one poll at a time, slower while the tab is hidden, at once when
  // it is visible again, and nothing more once this state is left.
  useEffect(() => {
    if (state.kind !== 'waiting') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const controller = new AbortController();
    const schedule = () => {
      timer = setTimeout(run, document.visibilityState === 'hidden' ? Math.max(pollMs, HIDDEN_POLL_MS) : pollMs);
    };
    function run(): void {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      void poll(controller.signal).then((kind) => {
        inFlight = false;
        // Only while still waiting: an answer that ends the wait must not arm one more poll before
        // this effect is cleaned up.
        if (kind === 'waiting' && !controller.signal.aborted) schedule();
      });
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      run();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed only when waiting starts
  }, [state.kind, pollMs]);

  useEffect(() => {
    if (state.kind !== 'approved' || reloadOnce.current) return;
    reloadOnce.current = true;
    reload();
  }, [state.kind, reload]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (name === '') return;
    setSending(true);
    try {
      const created = await createDeviceRequest(name);
      if (mounted.current) setState({ kind: 'waiting', code: created.code, expiresAt: created.expiresAt });
    } catch (error) {
      if (!mounted.current) return;
      const message = isApiError(error, 'rate_limited')
        ? 'Too many PCs are waiting for approval. Approve or deny them on the main PC first, then try again.'
        : isApiError(error, 'not_configured')
          ? 'Portly on the main PC is not set up for other PCs (PORTLY_REMOTE_ORIGIN is not set).'
          : errorMessage(error, 'Portly could not take the request.');
      setState({ kind: 'ask', error: message });
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  switch (state.kind) {
    case 'checking':
      return (
        <Panel icon={Laptop} title="Connect this PC to Portly">
          <SkeletonLines lines={3} />
        </Panel>
      );
    case 'unreachable':
      return (
        <Panel icon={TriangleAlert} tone="warning" title="Portly can’t be reached">
          <p className={styles.text}>{state.message}</p>
          <div className={styles.actions}>
            <Button variant="primary" icon={RefreshCw} onClick={state.retry}>
              Retry
            </Button>
          </div>
        </Panel>
      );
    case 'approved':
      return (
        <Panel icon={Laptop} title="Connected">
          <p className={styles.text}>This PC was approved. Loading Portly…</p>
        </Panel>
      );
    case 'waiting':
      return (
        <Panel icon={Clock} title="Waiting for approval on the main PC">
          <p className={styles.text}>
            On the main PC, open <strong>Settings → Devices</strong> in Portly, check that the request shows this code, and choose{' '}
            <strong>Approve</strong>. This page connects by itself once that is done.
          </p>
          <p className={styles.origin} aria-label="Code to compare">
            {state.code}
          </p>
          <p className={styles.text}>
            The request expires <RelativeExpiry at={state.expiresAt} /> if nobody answers it. The code is only for comparing by eye: it opens
            nothing by itself.
          </p>
        </Panel>
      );
    case 'ended':
      return (
        <Panel icon={state.why === 'denied' ? Ban : Clock} tone="warning" title={ENDED_TITLES[state.why]}>
          <p className={styles.text}>{ENDED_TEXTS[state.why]}</p>
          <div className={styles.actions}>
            <Button variant="primary" icon={Send} onClick={() => setState({ kind: 'ask', error: null })}>
              Ask again
            </Button>
          </div>
        </Panel>
      );
    default:
      return (
        <Panel icon={Laptop} title="Connect this PC to Portly">
          <p className={styles.text}>
            This PC is not connected to Portly on the main PC yet. Give it a name, ask to connect, and approve the request on the main PC in{' '}
            <strong>Settings → Devices</strong>. Once approved, this PC can use Portly like the main one, except for the few things that stay
            there: signing in to Google and Microsoft accounts, resetting credentials and approving other PCs.
          </p>
          <form onSubmit={(event) => void ask(event)} className={styles.form}>
            <Field label="Name of this PC" help="Shown on the main PC when approving, and in its list of connected PCs.">
              <Input
                value={label}
                maxLength={DEVICE_LABEL_MAX}
                autoComplete="off"
                autoFocus
                onChange={(event) => setLabel(event.currentTarget.value)}
                required
              />
            </Field>
            {state.error !== null ? (
              <Banner tone="danger" title="Portly did not take the request">
                {state.error}
              </Banner>
            ) : null}
            <div className={styles.actions}>
              <Button type="submit" variant="primary" icon={Send} loading={sending} disabled={label.trim() === ''}>
                Ask to connect
              </Button>
            </div>
          </form>
        </Panel>
      );
  }
}

const ENDED_TITLES = {
  denied: 'The request was denied on the main PC',
  expired: 'The request expired',
  gone: 'The request is no longer there',
} as const;

const ENDED_TEXTS = {
  denied: 'Nobody approved this PC. If that was a mistake, ask again and approve the new request on the main PC.',
  expired: 'A request lasts 10 minutes. Ask again, and approve the new request on the main PC within that time.',
  gone: 'Portly on the main PC no longer knows this request (it may have been restarted, or the request expired a while ago). Ask again.',
} as const;

/** "in 9 minutes" / "very soon" for the request's expiry, refreshed every half minute. */
function RelativeExpiry({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.round((Date.parse(at) - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return <>very soon</>;
  return <>in about {minutes === 1 ? '1 minute' : `${minutes} minutes`}</>;
}

/** The proxy points at the server's main port: the server would take this PC as the main one. */
export function MisroutedPage() {
  return (
    <Panel icon={TriangleAlert} tone="warning" title="This address reaches Portly the wrong way">
      <p className={styles.text}>
        Portly on the main PC answered this page as if it were its own, which means the reverse proxy (Tailscale Serve, for example) forwards to
        Portly’s main port instead of its port for other PCs. Nothing can be done here until that is fixed on the main PC: point the proxy at
        Portly’s remote port (the main port plus one, <code className={styles.code}>5758</code> by default) and reload this page.
      </p>
      <p className={styles.text}>
        The step-by-step guide is <code className={styles.code}>docs/setup/other-pcs.md</code> in the Portly folder on the main PC.
      </p>
    </Panel>
  );
}
