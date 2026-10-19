/**
 * Error, stale-data and query-state patterns every widget reuses (§10.4, §10.7):
 *
 * - `ErrorState` maps API error codes: `reauth_required` → the account + ReconnectButton,
 *   `not_configured` → a
 *   "Set up" link, `network_error` → what an unreachable backend means for this page load
 *   (`unreachableCopy`, following the local server store, without Retry while the page switches
 *   to the copy in this browser), anything else → Retry.
 * - `StaleIndicator` shows "Updated N min ago" with a warning when a refetch failed but cached
 *   data is still shown (§10.7 #4).
 * - `QueryView` renders a TanStack query: skeleton on first load, ErrorState when there is no
 *   data, an optional empty state, otherwise the children with the (possibly stale) data.
 */
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleAlert, RefreshCw, Settings2, TriangleAlert, Unplug, WifiOff } from 'lucide-react';
import { isApiError } from '../api/client.ts';
import { useAccount } from '../api/accounts.ts';
import { useLocalServer } from '../localServer/store.ts';
import { safeHref } from '../lib/openUrl.ts';
import { useFormatters } from '../lib/format.ts';
import { useNow } from '../lib/useNow.ts';
import { ReconnectButton } from './accounts/ReconnectButton.tsx';
import { Button } from './Button.tsx';
import { EmptyState } from './EmptyState.tsx';
import { SkeletonList } from './Skeleton.tsx';
import { Tooltip } from './Tooltip.tsx';
import { errorMessage, unreachableCopy } from './toast.ts';
import styles from './Display.module.css';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Where "Set up" leads for `not_configured` (an in-app route such as `#/settings/accounts?focus=todoist`). */
  setupHref?: string;
  setupLabel?: string;
  /** Overrides the default title. */
  title?: string;
  compact?: boolean;
}

export function ErrorState({ error, onRetry, setupHref, setupLabel = 'Set up', title, compact = false }: ErrorStateProps) {
  const accountId = isApiError(error) ? error.accountId : undefined;
  const account = useAccount(accountId);
  // Re-renders when a switch to the copy in this browser starts or is withdrawn (unreachableCopy).
  const localServer = useLocalServer();

  if (isApiError(error, 'reauth_required')) {
    const name = account?.label ?? account?.email ?? 'this account';
    return (
      <EmptyState
        icon={Unplug}
        compact={compact}
        title={title ?? `Reconnect ${name}`}
        body="Portly lost access to this account. Sign in again to keep things in sync."
        action={accountId ? <ReconnectButton accountId={accountId} /> : <SetupLink href="#/settings/accounts" label="Open accounts" />}
      />
    );
  }

  if (isApiError(error, 'not_configured')) {
    return (
      <EmptyState
        icon={Settings2}
        compact={compact}
        title={title ?? 'Not set up yet'}
        body={error.message}
        action={setupHref ? <SetupLink href={setupHref} label={setupLabel} /> : undefined}
      />
    );
  }

  const unreachable = isApiError(error, 'network_error') ? unreachableCopy(localServer) : null;
  return (
    <EmptyState
      icon={unreachable ? WifiOff : CircleAlert}
      compact={compact}
      title={title ?? unreachable?.title ?? 'Something went wrong'}
      body={unreachable ? unreachable.hint : errorMessage(error, 'The data could not be loaded.')}
      action={
        onRetry && unreachable?.retry !== false ? (
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}

function SetupLink({ href, label }: { href: string; label: string }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <a className={styles.setupLink} href={safe}>
      <Settings2 aria-hidden="true" />
      {label}
    </a>
  );
}

export interface StaleIndicatorProps {
  /** When the shown data was fetched (epoch ms; TanStack `dataUpdatedAt`). */
  updatedAt: number;
  /** The refetch error, if the last refresh failed. */
  error?: unknown;
  /** Always show "Updated …", not only after a failed refresh. */
  always?: boolean;
  onRetry?: () => void;
}

/** "Updated 5 min ago" + warning icon when the last refresh failed. */
export function StaleIndicator({ updatedAt, error, always = false, onRetry }: StaleIndicatorProps) {
  const now = useNow(30_000);
  const fmt = useFormatters();
  const failed = error !== undefined && error !== null;
  if (!updatedAt || (!failed && !always)) return null;
  const label = `Updated ${fmt.relative(updatedAt, now)}`;
  const content = (
    <span className={styles.stale} data-failed={failed ? 'true' : undefined} role="status">
      {failed ? <TriangleAlert aria-hidden="true" /> : null}
      <span>{label}</span>
      {failed ? <span className="hb-visually-hidden">. Refresh failed: {errorMessage(error)}</span> : null}
    </span>
  );
  if (!failed) return content;
  return (
    <Tooltip content={`Couldn't refresh: ${errorMessage(error)}${onRetry ? ' Click to retry.' : ''}`}>
      {onRetry ? (
        <button type="button" className={styles.staleButton} onClick={onRetry}>
          {content}
        </button>
      ) : (
        <span tabIndex={0}>{content}</span>
      )}
    </Tooltip>
  );
}

export interface QueryViewMeta {
  /** The last refresh failed; `data` is from an earlier fetch. */
  stale: boolean;
  updatedAt: number;
  error: unknown;
  refetch: () => void;
}

export interface QueryViewProps<T> {
  query: Pick<UseQueryResult<T>, 'data' | 'error' | 'isPending' | 'isError' | 'refetch' | 'dataUpdatedAt'>;
  children: (data: T, meta: QueryViewMeta) => ReactNode;
  /** First-load placeholder (default: a skeleton list). */
  skeleton?: ReactNode;
  /** Passed to ErrorState for `not_configured`. */
  setupHref?: string;
  setupLabel?: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  compact?: boolean;
}

/**
 * `meta.updatedAt` and `meta.error` are read from the query only when the children read them:
 * TanStack re-renders a component for each result field it read, and `dataUpdatedAt` changes on
 * every refetch, even one that brings the same data (a launch pad would re-render all its tiles).
 */
export function QueryView<T>({ query, children, skeleton, setupHref, setupLabel, isEmpty, empty, compact }: QueryViewProps<T>) {
  const refetch = () => void query.refetch();
  if (query.data === undefined) {
    if (query.isError) {
      return <ErrorState error={query.error} onRetry={refetch} setupHref={setupHref} setupLabel={setupLabel} compact={compact} />;
    }
    return <>{skeleton ?? <SkeletonList />}</>;
  }
  if (isEmpty?.(query.data) && empty !== undefined) return <>{empty}</>;
  const meta: QueryViewMeta = {
    stale: query.isError,
    get updatedAt() {
      return query.dataUpdatedAt;
    },
    get error() {
      return query.error;
    },
    refetch,
  };
  return <>{children(query.data, meta)}</>;
}
