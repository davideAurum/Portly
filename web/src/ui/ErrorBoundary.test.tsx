/**
 * The error boundary contains a crashing part of the page and records it as an `app` error event;
 * `recordAppError` (also used for the window's uncaught errors and unhandled rejections) keeps the
 * name, message and stack frames, counts repeats instead of recording them again, and ignores
 * cancelled requests.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_EVENT_REPEAT_WINDOW_MS } from '../api/client.ts';
import { getClientEvents } from '../diagnostics/clientLog.ts';
import { ErrorBoundary, recordAppError } from './ErrorBoundary.tsx';

const events = () => getClientEvents().map((entry) => entry.event);

function Crash(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'items')");
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ErrorBoundary', () => {
  it('shows the fallback and records the render error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={(error) => <p>Failed: {error.name}</p>}>
        <Crash />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Failed: TypeError')).toBeInTheDocument();
    expect(events()).toEqual([
      expect.objectContaining({
        level: 'error',
        cat: 'app',
        msg: 'part of the page failed to render',
        fields: expect.objectContaining({ source: 'render', errName: 'TypeError', errMessage: "Cannot read properties of undefined (reading 'items')" }),
      }),
    ]);
    const stack = events()[0]?.fields.stack;
    expect(Array.isArray(stack) && stack.every((frame) => typeof frame === 'string' && frame.startsWith('at '))).toBe(true);
  });
});

describe('recordAppError', () => {
  it('counts the same error from the same place instead of recording it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let i = 0; i < 5; i++) recordAppError('window', new Error('boom'));
    recordAppError('promise', new Error('boom'));
    expect(events().map((event) => event.msg)).toEqual(['uncaught error', 'unhandled promise rejection']);
    await vi.advanceTimersByTimeAsync(CLIENT_EVENT_REPEAT_WINDOW_MS);
    expect(events().at(-1)).toMatchObject({ msg: 'uncaught error', fields: { source: 'window', errName: 'Error', errMessage: 'boom', repeats: 4 } });
  });

  it('takes any rejection value, and ignores a cancelled request', () => {
    recordAppError('promise', 'plain text reason');
    recordAppError('promise', 42);
    recordAppError('promise', new DOMException('The operation was aborted.', 'AbortError'));
    expect(events().map((event) => event.fields)).toEqual([
      { errName: 'string', errMessage: 'plain text reason', source: 'promise' },
      { errName: 'number', source: 'promise' },
    ]);
  });
});
