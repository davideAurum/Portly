/**
 * Root component: applies the theme from settings (every cache update, so Appearance changes
 * preview instantly), reports `?oauth=<result>` once as a toast (then strips it from the URL,
 * keeping the hash route, §10.5), and renders the shell — or, for `#/pair?nonce=…`, the pairing
 * page on its own (no dashboard around a consent screen; loaded only when that route opens, with a
 * note to reload if its code cannot be loaded), and in the Pages build, for `#/connect`, the page
 * that connects this browser to Portly on the main PC.
 */
import { Suspense, lazy, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { OAuthResultSchema, type OAuthResult } from '@portly/shared';
import { invalidateAccountData } from '../api/keys.ts';
import { getCapabilities } from '../capabilities.ts';
import { useApplyTheme } from '../theme/useTheme.ts';
import { Button } from '../ui/Button.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { toast } from '../ui/toast.ts';
import { useRoute } from './router.ts';
import { Shell } from './Shell.tsx';

const PairPage = lazy(() => import('./PairPage.tsx').then((m) => ({ default: m.PairPage })));
const RemoteConnectPage = lazy(() => import('./RemoteConnectPage.tsx').then((m) => ({ default: m.RemoteConnectPage })));

export const OAUTH_MESSAGES: Readonly<Record<OAuthResult, { kind: 'success' | 'error' | 'info'; text: string }>> = Object.freeze({
  connected: { kind: 'success', text: 'Account connected.' },
  reconnected: { kind: 'success', text: 'Account reconnected.' },
  different_account: {
    kind: 'info',
    text: 'You signed in with a different account, so it was added as a new account. The original account still needs reconnecting.',
  },
  denied: { kind: 'error', text: 'Access was not granted, so the account was not connected.' },
  expired: { kind: 'error', text: 'The sign-in took too long and expired. Please try again.' },
  error: { kind: 'error', text: 'The account could not be connected. Please try again.' },
});

/**
 * Reads `?oauth=` once and removes it from the URL (keeping the path and hash route). Unknown
 * values are reported as `error`; the raw value is never shown.
 */
export function consumeOAuthResult(): OAuthResult | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('oauth');
  if (raw === null) return null;
  url.searchParams.delete('oauth');
  window.history.replaceState(window.history.state, '', url);
  const parsed = OAuthResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'error';
}

export function showOAuthToast(result: OAuthResult): void {
  const message = OAUTH_MESSAGES[result];
  if (message.kind === 'success') toast.success(message.text);
  else if (message.kind === 'error') toast.error(message.text);
  else toast.info(message.text, { duration: 10_000 });
}

export function App() {
  const queryClient = useQueryClient();
  const route = useRoute();
  useApplyTheme();

  useEffect(() => {
    const result = consumeOAuthResult();
    if (!result) return;
    showOAuthToast(result);
    if (result === 'connected' || result === 'reconnected' || result === 'different_account') {
      void invalidateAccountData(queryClient);
    }
  }, [queryClient]);

  if (route.name === 'connect' && getCapabilities().pagesBuild) {
    return (
      <ErrorBoundary fallback={() => <PairPageUnavailable />}>
        <Suspense fallback={null}>
          <RemoteConnectPage />
        </Suspense>
      </ErrorBoundary>
    );
  }
  if (route.name !== 'pair') return <Shell />;
  return (
    <ErrorBoundary fallback={() => <PairPageUnavailable />}>
      <Suspense fallback={null}>
        <PairPage nonce={route.nonce} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** In place of the pairing page when its code could not be loaded (network, or a newer deploy). */
function PairPageUnavailable() {
  return (
    <main>
      <EmptyState
        icon={TriangleAlert}
        title="The pairing page could not be loaded"
        body="Reload the page to try again."
        action={
          <Button size="sm" icon={RefreshCw} onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
    </main>
  );
}
