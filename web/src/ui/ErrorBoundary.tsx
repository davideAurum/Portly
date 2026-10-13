import { Component, type ErrorInfo, type ReactNode } from 'react';
import { recordCollapsedClientEvent } from '../api/client.ts';

export interface ErrorBoundaryProps {
  /** Rendered instead of the children after an error; receives a reset callback. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Where an uncaught error was caught: a render (this boundary), the window, or an unhandled rejection. */
export type AppErrorSource = 'render' | 'window' | 'promise';

const APP_ERROR_MESSAGES: Readonly<Record<AppErrorSource, string>> = Object.freeze({
  render: 'part of the page failed to render',
  window: 'uncaught error',
  promise: 'unhandled promise rejection',
});

/**
 * Records an uncaught error as this browser's `app` event (ARCHITECTURE §17): its name, message and
 * first stack frames (the event log scrubs and trims them), and where it was caught. The same error
 * from the same place within a minute is counted, not recorded again (a render loop throws
 * hundreds). A cancelled request is not an error. Never throws.
 */
export function recordAppError(source: AppErrorSource, error: unknown): void {
  try {
    const value = typeof error === 'object' && error !== null ? (error as { name?: unknown; message?: unknown; stack?: unknown }) : null;
    const errName = typeof value?.name === 'string' ? value.name : typeof error;
    if (errName === 'AbortError') return;
    const errMessage = typeof value?.message === 'string' ? value.message : typeof error === 'string' ? error : undefined;
    const stack = typeof value?.stack === 'string' ? value.stack : undefined;
    recordCollapsedClientEvent('app', `${source} ${errName} ${(errMessage ?? '').slice(0, 120)}`, 'error', APP_ERROR_MESSAGES[source], { errName, errMessage, source, stack });
  } catch {
    // Reporting an error must never raise another.
  }
}

/**
 * Contains render errors (e.g. a crashing widget, or code that could not be loaded) so the rest of
 * the page keeps working. Each one is also recorded as an `app` error event ({@link recordAppError}).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Portly] Part of the page failed to render', error, info.componentStack);
    recordAppError('render', error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}
