/** CAL-5: events queries read visible calendars by default, or exactly a widget's own list. */
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, EventsResponse } from '@homebase/shared';
import { createTestQueryClient, stubApi, type MockRequest } from '../test/render.tsx';
import { eventsPath, selectionKey, useCalendarEvents, useUpdateCalendar } from './calendar.ts';
import { qk } from './keys.ts';

afterEach(() => vi.unstubAllGlobals());

const range = { from: '2026-09-21', to: '2026-09-28', tz: 'America/Chicago' };
const empty: EventsResponse = { events: [], window: { from: range.from, to: range.to } };

describe('events selection', () => {
  it('asks for the visible calendars by default and names a widget’s own list explicitly', () => {
    expect(eventsPath(range)).toBe('/api/calendar/events?from=2026-09-21&to=2026-09-28&tz=America%2FChicago');
    expect(eventsPath(range, ['b', 'a', 'b'])).toBe('/api/calendar/events?from=2026-09-21&to=2026-09-28&tz=America%2FChicago&calendarIds=a%2Cb');
    expect(selectionKey(['b', 'a'])).toBe(selectionKey(['a', 'b']));
    expect(qk.calendar.events(range.from, range.to, range.tz, selectionKey(['a']))).not.toEqual(qk.calendar.events(range.from, range.to, range.tz));
  });

  it('a widget with an explicit list sends calendarIds; hiding a calendar refreshes the events queries', async () => {
    const { requests } = stubApi({
      'GET /api/calendar/events': empty,
      'PATCH /api/calendar/calendars/:id': (req: MockRequest) => ({ id: req.params.id, visible: false }) as unknown as Calendar,
    });
    const client = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    const hook = renderHook(() => ({ events: useCalendarEvents(range, { calendars: ['cal-2'] }), update: useUpdateCalendar() }), { wrapper });
    await waitFor(() => expect(hook.result.current.events.isSuccess).toBe(true));
    expect(requests[0]!.search).toContain('calendarIds=cal-2');

    await act(() => hook.result.current.update.mutateAsync({ id: 'cal-1', visible: false }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/calendar/events')).toHaveLength(2));

    // A color change does not refetch events.
    await act(() => hook.result.current.update.mutateAsync({ id: 'cal-1', colorOverride: '#112233' }));
    expect(requests.filter((r) => r.path === '/api/calendar/events')).toHaveLength(2);
  });
});
