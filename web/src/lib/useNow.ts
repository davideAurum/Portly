/**
 * `useNow(intervalMs)` — the current time, re-rendering on interval boundaries (a clock with a
 * 60 s interval ticks exactly at :00). One shared timer per interval serves every subscriber. A
 * hidden tab has nothing to show, so the timers stop while it is hidden; when it becomes visible
 * again the time is refreshed at once and the timers start over (timers are throttled in
 * background tabs and after sleep anyway).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

interface Ticker {
  interval: number;
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const tickers = new Map<number, Ticker>();
let activeTickers = 0;

function notify(ticker: Ticker): void {
  for (const listener of ticker.listeners) listener();
}

function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

function stopTimer(ticker: Ticker): void {
  if (ticker.timer !== null) clearTimeout(ticker.timer);
  ticker.timer = null;
}

/** Arms the timer for the next interval boundary (none while the tab is hidden). */
function schedule(ticker: Ticker): void {
  stopTimer(ticker);
  if (hidden()) return;
  const delay = ticker.interval - (Date.now() % ticker.interval);
  ticker.timer = setTimeout(() => {
    ticker.timer = null;
    ticker.now = Date.now();
    notify(ticker);
    schedule(ticker);
  }, delay);
}

function onVisibilityChange(): void {
  if (hidden()) {
    for (const ticker of tickers.values()) stopTimer(ticker);
    return;
  }
  const now = Date.now();
  for (const ticker of tickers.values()) {
    if (ticker.listeners.size === 0) continue;
    ticker.now = now;
    notify(ticker);
    schedule(ticker);
  }
}

function getTicker(interval: number): Ticker {
  let ticker = tickers.get(interval);
  if (!ticker) {
    ticker = { interval, now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(interval, ticker);
  }
  return ticker;
}

function subscribe(interval: number, listener: () => void): () => void {
  const ticker = getTicker(interval);
  if (ticker.listeners.size === 0) {
    ticker.now = Date.now();
    schedule(ticker);
    activeTickers += 1;
    if (activeTickers === 1) document.addEventListener('visibilitychange', onVisibilityChange);
  }
  ticker.listeners.add(listener);
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size > 0) return;
    stopTimer(ticker);
    tickers.delete(interval);
    activeTickers -= 1;
    if (activeTickers === 0) document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

/** The current time as a Date, updated every `intervalMs` (aligned to the interval boundary) while the tab is visible. */
export function useNow(intervalMs = 60_000): Date {
  const interval = Math.max(250, Math.floor(intervalMs));
  const sub = useCallback((listener: () => void) => subscribe(interval, listener), [interval]);
  const snapshot = useCallback(() => getTicker(interval).now, [interval]);
  const now = useSyncExternalStore(sub, snapshot, Date.now);
  return useMemo(() => new Date(now), [now]);
}
