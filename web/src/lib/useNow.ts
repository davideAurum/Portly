/**
 * `useNow(intervalMs)` — the current time, re-rendering on interval boundaries (a clock with a
 * 60 s interval ticks exactly at :00). One shared timer per interval serves every subscriber, and
 * the time is refreshed immediately when a hidden tab becomes visible again (timers are throttled
 * in background tabs and after sleep).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const tickers = new Map<number, Ticker>();
let activeTickers = 0;

function notify(ticker: Ticker): void {
  for (const listener of ticker.listeners) listener();
}

function schedule(interval: number, ticker: Ticker): void {
  const delay = interval - (Date.now() % interval);
  ticker.timer = setTimeout(() => {
    ticker.now = Date.now();
    notify(ticker);
    schedule(interval, ticker);
  }, delay);
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  for (const ticker of tickers.values()) {
    if (ticker.listeners.size === 0) continue;
    ticker.now = now;
    notify(ticker);
  }
}

function getTicker(interval: number): Ticker {
  let ticker = tickers.get(interval);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(interval, ticker);
  }
  return ticker;
}

function subscribe(interval: number, listener: () => void): () => void {
  const ticker = getTicker(interval);
  if (ticker.listeners.size === 0) {
    ticker.now = Date.now();
    schedule(interval, ticker);
    activeTickers += 1;
    if (activeTickers === 1) document.addEventListener('visibilitychange', onVisibilityChange);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size > 0) return;
    if (ticker.timer !== null) clearTimeout(ticker.timer);
    ticker.timer = null;
    tickers.delete(interval);
    activeTickers -= 1;
    if (activeTickers === 0) document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

/** The current time as a Date, updated every `intervalMs` (aligned to the interval boundary). */
export function useNow(intervalMs = 60_000): Date {
  const interval = Math.max(250, Math.floor(intervalMs));
  const sub = useCallback((listener: () => void) => subscribe(interval, listener), [interval]);
  const snapshot = useCallback(() => getTicker(interval).now, [interval]);
  const now = useSyncExternalStore(sub, snapshot, Date.now);
  return useMemo(() => new Date(now), [now]);
}
