/**
 * Toasts (§10.4): sonner, with helpers for the two patterns every feature needs — reporting a
 * failed request with the server's message, and an optimistic action with Undo. What an
 * unreachable backend (`network_error`) means depends on this page load's backend: the Portly
 * server (server build), Portly on this PC (Pages build, hybrid mode; or the page is switching
 * away from it) or the copy in this browser ({@link unreachableCopy}, shared with `ErrorState`).
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { isApiError } from '../api/client.ts';
import { getCapabilities } from '../capabilities.ts';
import { getLocalServerState } from '../localServer/store.ts';
import type { LocalServerState } from '../localServer/types.ts';

export { toast };

// ---------------------------------------------------------------------------
// Bottom bars (e.g. the dashboard's edit toolbar) push the toasts up so a toast never covers
// the bar's buttons ("Done" sits where bottom-right toasts appear on medium-width windows).
// ---------------------------------------------------------------------------

let bottomBars = 0;
const offsetListeners = new Set<() => void>();

function notifyOffset(): void {
  for (const listener of offsetListeners) listener();
}

/** Declares a fixed bar at the bottom of the viewport; call the returned function when it goes away. */
export function reserveToastSpace(): () => void {
  bottomBars += 1;
  notifyOffset();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bottomBars -= 1;
    notifyOffset();
  };
}

function subscribeOffset(listener: () => void): () => void {
  offsetListeners.add(listener);
  return () => offsetListeners.delete(listener);
}

/** True while a bottom bar is shown (the Toaster then raises its bottom offset). */
export function useToastSpaceReserved(): boolean {
  return useSyncExternalStore(
    subscribeOffset,
    () => bottomBars > 0,
    () => false,
  );
}

export interface UnreachableCopy {
  /** A short title, e.g. for an error state. */
  title: string;
  /** What to do about it. */
  hint: string;
  /** One sentence for a toast. */
  message: string;
  /** Retrying the request can succeed (false while the page switches to the copy in this browser). */
  retry: boolean;
}

/**
 * What `network_error` means on this page load's backend (read at call time; `ErrorState` passes
 * the local server state it subscribes to). On Portly on this PC, a switch to the copy in this
 * browser that waits for the page to be idle ends server mode: every request fails until the
 * reload, although the server may well be running, so the copy says the page is switching.
 */
export function unreachableCopy(localServer: LocalServerState = getLocalServerState()): UnreachableCopy {
  const caps = getCapabilities();
  if (caps.backend === 'browser') {
    // The in-browser backend could not answer (its storage failed to open, or it is reloading).
    return {
      title: "Portly couldn't load its data",
      hint: 'Reload the page to try again.',
      message: "Portly couldn't load its data. Reload the page to try again.",
      retry: true,
    };
  }
  if (caps.remoteServer && localServer.pendingSwitch?.target === 'browser') {
    return {
      title: 'This page is switching to the copy saved in this browser',
      hint: "It reloads when you're done; Switch now in the banner above does it right away.",
      message: 'This page is switching to the copy saved in this browser.',
      retry: false,
    };
  }
  if (caps.remoteServer) {
    return {
      title: "Portly on this PC isn't reachable",
      hint: 'Check that Portly is running on this PC. This page reconnects when it is back.',
      message: "Portly on this PC isn't reachable. Is it running?",
      retry: true,
    };
  }
  return {
    title: 'Portly is not reachable',
    hint: 'Check that the Portly server is running.',
    message: 'Portly is not reachable. Is the server running?',
    retry: true,
  };
}

/** A user-facing message for any error (the server's message for API errors). */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (isApiError(error)) {
    if (error.code === 'network_error') return unreachableCopy().message;
    return error.message || fallback;
  }
  return fallback;
}

/** Shows an error toast for a failed request. */
export function toastError(error: unknown, fallback?: string): void {
  toast.error(errorMessage(error, fallback));
}

export interface UndoToastOptions {
  /** Called when the user clicks Undo. */
  onUndo: () => void | Promise<void>;
  /** Undo label (default "Undo"). */
  label?: string;
  duration?: number;
}

/** A success toast with an Undo action (for reversible optimistic mutations, §10.7). */
export function toastUndo(message: string, { onUndo, label = 'Undo', duration = 6000 }: UndoToastOptions): string | number {
  return toast.success(message, {
    duration,
    action: {
      label,
      onClick: () => {
        void Promise.resolve(onUndo()).catch((error: unknown) => toastError(error, 'Could not undo.'));
      },
    },
  });
}
