/**
 * What a server-only feature shows on a page load whose data lives in this browser
 * (`backend === 'browser'`): a calendar, mail or feeds widget still in a layout, or the Accounts /
 * Calendars settings section opened by URL.
 *
 * With hybrid mode on, the feature works once this browser uses the Homebase server on this PC,
 * so the notice says "needs Homebase running on this PC" and offers the one step that gets closer,
 * through the local server store's actions: **Look for it** before the first check (a user
 * gesture, which may bring up the browser's local network permission prompt), **Pair this
 * browser** when Homebase answers but this browser is not paired with it (or no longer, or with a
 * different Homebase: the local server panel's pairable statuses), **Switch now** when the switch
 * only waits for the page to be idle, and **Check again** otherwise. Without
 * hybrid mode (or inside a frame, which never uses the local server) there is no server to find:
 * the plain notice.
 */
import { ArrowRightLeft, CircleAlert, Link2, RefreshCw, Search, type LucideIcon } from 'lucide-react';
import { HYBRID_ENABLED } from '../localServer/config.ts';
import { localServerActions, useLocalServer } from '../localServer/store.ts';
import type { LocalServerState, LocalServerStatus } from '../localServer/types.ts';
import { Button } from './Button.tsx';
import { EmptyState } from './EmptyState.tsx';

/** Body of the notice when there is no Homebase server to use (no hybrid mode, or a framed page). */
export const NO_SERVER_NOTICE = 'Not available in the browser-only build.';

/** Body of the notice in hybrid mode. */
export const NEEDS_LOCAL_SERVER_NOTICE = 'It works while this browser is connected to Homebase on this PC.';

export interface ServerOnlyNoticeProps {
  /** What needs the server, as the title names it ("Calendar", "Accounts"). */
  feature: string;
  /** A sentence appended to the body, e.g. "Remove it in edit mode." */
  hint?: string;
  /** EmptyState's single-row layout (icon, title and action only). */
  compact?: boolean;
  icon?: LucideIcon;
}

interface NoticeAction {
  label: string;
  icon: LucideIcon;
  run(): void;
}

/**
 * Homebase answers but will not serve this browser until it pairs (again). Checking again cannot
 * help: a different Homebase (e.g. after a reinstall) stays different.
 */
const PAIRABLE: ReadonlySet<LocalServerStatus> = new Set(['unpaired', 'revoked', 'other-server']);

/** The step that gets this browser closer to using Homebase on this PC. */
function nextStep(state: LocalServerState): NoticeAction {
  if (state.pendingSwitch?.target === 'server') return { label: 'Switch now', icon: ArrowRightLeft, run: localServerActions.switchNow };
  if (state.status === 'idle') return { label: 'Look for it', icon: Search, run: localServerActions.lookForServer };
  if (PAIRABLE.has(state.status)) return { label: 'Pair this browser', icon: Link2, run: localServerActions.startPairing };
  return { label: 'Check again', icon: RefreshCw, run: localServerActions.checkNow };
}

export function ServerOnlyNotice({ feature, hint, compact = false, icon = CircleAlert }: ServerOnlyNoticeProps) {
  const state = useLocalServer();
  const suffix = hint ? ` ${hint}` : '';
  const hybrid = HYBRID_ENABLED && state.status !== 'disabled' && state.status !== 'framed';
  if (!hybrid) {
    return <EmptyState icon={icon} title={`${feature} needs the Homebase server`} body={`${NO_SERVER_NOTICE}${suffix}`} compact={compact} />;
  }
  const step = nextStep(state);
  const checking = state.status === 'checking' || state.status === 'waiting-permission';
  return (
    <EmptyState
      icon={icon}
      title={`${feature} needs Homebase running on this PC`}
      body={`${NEEDS_LOCAL_SERVER_NOTICE}${suffix}`}
      compact={compact}
      action={
        <Button size="sm" icon={step.icon} loading={checking} onClick={() => step.run()}>
          {step.label}
        </Button>
      }
    />
  );
}
