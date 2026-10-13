import type { ReactNode } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Settings, Task } from '@homebase/shared';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { settings } from '../../test/fixtures.ts';
import type { QueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys.ts';
import { createTestQueryClient, mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { todoistConfigSchema, type TodoistConfig } from './index.ts';
import TodoistWidget from './Widget.tsx';

function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    content: `Task ${id}`,
    description: '',
    projectId: 'p-home',
    due: null,
    priority: 1,
    labels: [],
    url: `https://app.todoist.com/app/task/${id}`,
    ...extra,
  };
}

const PROJECTS: Project[] = [
  { id: 'p-home', name: 'Home', color: '#299438' },
  { id: 'p-work', name: 'Work', color: null },
];

let actionsHost: HTMLDivElement;
let openSettings = vi.fn<() => void>();
beforeEach(() => {
  actionsHost = document.createElement('div');
  document.body.appendChild(actionsHost);
  openSettings = vi.fn<() => void>();
});
afterEach(() => actionsHost.remove());

function frame(children: ReactNode) {
  const value: WidgetFrameContextValue = {
    instanceId: 'w1',
    title: 'Todoist',
    openSettings: () => openSettings(),
    canOpenSettings: true,
    actionsTarget: actionsHost,
  };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function renderWidget(
  options: {
    tasks?: Task[];
    config?: Partial<TodoistConfig>;
    size?: { w: number; h: number };
    settings?: Settings;
    mocks?: Record<string, ApiMock>;
    queryClient?: QueryClient;
  } = {},
) {
  const server = { tasks: [...(options.tasks ?? [])] };
  const calls: MockRequest[] = [];
  const setConfig = vi.fn(async () => {});
  const config = todoistConfigSchema.parse(options.config ?? {});
  const result = renderWithProviders(
    frame(<TodoistWidget instanceId="w1" config={config} setConfig={setConfig} size={options.size ?? { w: 4, h: 7 }} editMode={false} />),
    {
      apiMocks: {
        'GET /api/settings': options.settings ?? settings(),
        'GET /api/todoist/projects': PROJECTS,
        'GET /api/todoist/tasks': (req: MockRequest) => {
          calls.push(req);
          return server.tasks;
        },
        ...options.mocks,
      },
      ...(options.queryClient ? { queryClient: options.queryClient } : {}),
    },
  );
  return Object.assign(result, { server, calls, setConfig });
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem');
}

function rowTexts(): string[] {
  return rows().map((row) => within(row).getByRole('checkbox').getAttribute('aria-label') ?? '');
}

describe('Todoist widget: not connected (PERF-2)', () => {
  it('a known "not configured" token status shows Connect Todoist at once and never asks for tasks', async () => {
    // As restored from the persisted cache on a new tab.
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(qk.todoist.token(), { configured: false });
    const result = renderWidget({ mocks: { 'GET /api/todoist/token': { configured: false } }, queryClient });
    // The very first render already shows the call to action.
    expect(screen.getByText('Connect Todoist')).toBeInTheDocument();
    await waitFor(() => expect(result.requestsTo('GET /api/settings')).toHaveLength(1));
    // Past the filter's settle delay: still no tasks request (it could only answer 409).
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(result.calls).toHaveLength(0);
    expect(screen.getByText('Connect Todoist')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
  });
});

describe('Todoist widget: rendering', () => {
  it('shows the list title, count and task details as plain text', async () => {
    renderWidget({
      tasks: [
        task('a', {
          content: 'Read [the spec](https://example.com/spec) **now**',
          description: 'Chapter 3\nmore',
          due: { date: localDate(-2), datetime: null, string: 'every day', isRecurring: true },
          priority: 4,
          labels: ['reading'],
        }),
        task('b', { content: 'Water plants', projectId: 'p-work', due: { date: localDate(0), datetime: null, string: 'today', isRecurring: false } }),
      ],
    });

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByLabelText('2 tasks')).toHaveTextContent('2');

    const [first] = rows();
    // Markdown is plain text; the only link opens the task in Todoist (new tab, no referrer).
    const link = within(first!).getByRole('link');
    expect(link).toHaveTextContent('Read the spec now');
    expect(link).toHaveAttribute('href', 'https://app.todoist.com/app/task/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(first!).queryByRole('link', { name: /example\.com/ })).toBeNull();
    expect(within(first!).getByText('Chapter 3')).toBeInTheDocument();
    expect(within(first!).getByText('Priority 1')).toBeInTheDocument();
    expect(within(first!).getByText('reading')).toBeInTheDocument();
    expect(within(first!).getByText(/Overdue:/).closest('[data-status]')).toHaveAttribute('data-status', 'overdue');
    expect(within(first!).getByText(', repeats')).toBeInTheDocument();
    expect(within(first!).getByRole('checkbox')).toHaveAttribute('data-priority', '4');

    // Project chips come from /projects.
    expect(await within(first!).findByText('Home')).toBeInTheDocument();
    expect(within(rows()[1]!).getByText('Work')).toBeInTheDocument();
    expect(within(rows()[1]!).getByText('Today').closest('[data-status]')).toHaveAttribute('data-status', 'today');
  });

  it('requests the default filter from settings, or the widget filter', async () => {
    const first = renderWidget({ settings: settings({ todoist: { defaultFilter: '#Inbox' } }) });
    await waitFor(() => expect(first.calls).toHaveLength(1));
    expect(new URLSearchParams(first.calls[0]!.search).get('filter')).toBe('#Inbox');
    expect(await screen.findByRole('heading', { name: '#Inbox' })).toBeInTheDocument();
    first.unmount();

    const second = renderWidget({ config: { filter: 'p1', title: 'Urgent' } });
    await waitFor(() => expect(second.calls).toHaveLength(1));
    expect(new URLSearchParams(second.calls[0]!.search).get('filter')).toBe('p1');
    expect(await screen.findByRole('heading', { name: 'Urgent' })).toBeInTheDocument();
  });

  it('hides project and due chips when switched off', async () => {
    renderWidget({
      config: { showProject: false, showDue: false },
      tasks: [task('a', { due: { date: localDate(0), datetime: null, string: 'today', isRecurring: false } })],
    });
    const list = await screen.findByRole('list', { name: 'Tasks' });
    expect(within(list).getByText('Task a')).toBeInTheDocument();
    expect(within(list).queryByText('Today')).toBeNull();
    expect(within(list).queryByText('Home')).toBeNull();
  });

  it('shows an empty state when nothing matches', async () => {
    renderWidget({ tasks: [] });
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('Nothing matches “today | overdue”.')).toBeInTheDocument();
  });
});

describe('Todoist widget: states', () => {
  it('not configured → "Connect Todoist" with a link to the settings page', async () => {
    renderWidget({
      mocks: { 'GET /api/todoist/tasks': mockError(409, 'not_configured', 'Todoist is not connected.', { details: { reason: 'no_token' } }) },
    });
    expect(await screen.findByText('Connect Todoist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up Todoist/ })).toHaveAttribute('href', '#/settings/todoist');
    expect(screen.queryByRole('textbox', { name: 'Add a task' })).toBeNull();
  });

  it('a rejected token asks for a new one', async () => {
    renderWidget({
      mocks: { 'GET /api/todoist/tasks': mockError(409, 'not_configured', 'Todoist rejected the saved API token.', { details: { reason: 'token_rejected' } }) },
    });
    expect(await screen.findByText('Todoist token rejected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up Todoist/ })).toHaveAttribute('href', '#/settings/todoist');
  });

  it('a locked vault points to Settings → Accounts', async () => {
    renderWidget({ mocks: { 'GET /api/todoist/tasks': mockError(409, 'reauth_required', 'The credential vault is locked') } });
    expect(await screen.findByText('Saved credentials are locked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open settings/ })).toHaveAttribute('href', '#/settings/accounts');
  });

  it('keeps the list with a warning when a refresh fails, but shows setup problems at once', async () => {
    let answer: ApiMock = [task('a', { content: 'Keep me' })];
    const h = renderWidget({ mocks: { 'GET /api/todoist/tasks': () => answer } });
    expect(await screen.findByRole('checkbox', { name: 'Complete “Keep me”' })).toBeInTheDocument();

    answer = mockError(502, 'provider_error', 'Todoist is having problems (HTTP 503).');
    await h.queryClient.refetchQueries({ queryKey: ['todoist', 'tasks'] });
    expect(await within(actionsHost).findByText(/^Updated/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Complete “Keep me”' })).toBeInTheDocument();

    answer = mockError(409, 'not_configured', 'Todoist rejected the saved API token.', { details: { reason: 'token_rejected' } });
    await h.queryClient.refetchQueries({ queryKey: ['todoist', 'tasks'] });
    expect(await screen.findByText('Todoist token rejected')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Complete “Keep me”' })).toBeNull();
  });

  it('a filter Todoist cannot parse offers to edit the widget filter (not a pointless Retry)', async () => {
    const user = userEvent.setup();
    renderWidget({
      config: { filter: '((' },
      mocks: {
        'GET /api/todoist/tasks': mockError(422, 'validation_failed', 'Todoist could not understand this filter. Check its syntax.', {
          details: { reason: 'invalid_filter' },
        }),
      },
    });
    expect(await screen.findByText('Check the filter')).toBeInTheDocument();
    expect(screen.getByText('Todoist could not understand this filter. Check its syntax.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit filter' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('a broken default filter links to Settings → Todoist', async () => {
    renderWidget({
      settings: settings({ todoist: { defaultFilter: '((' } }),
      mocks: {
        'GET /api/todoist/tasks': mockError(422, 'validation_failed', 'Todoist could not understand this filter. Check its syntax.', {
          details: { reason: 'invalid_filter' },
        }),
      },
    });
    expect(await screen.findByText('Check the filter')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Edit default filter/ })).toHaveAttribute('href', '#/settings/todoist');
  });

  it('other errors offer Retry', async () => {
    let fail = true;
    renderWidget({
      mocks: {
        'GET /api/todoist/tasks': () => (fail ? mockError(429, 'rate_limited', 'Todoist is rate limiting requests.') : [task('a')]),
      },
    });
    expect(await screen.findByText('Todoist is rate limiting requests.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Tasks' })).toBeInTheDocument();
  });
});

describe('Todoist widget: completing', () => {
  it('removes the task optimistically and Undo reopens it', async () => {
    const user = userEvent.setup();
    let releaseClose!: () => void;
    const closed = new Promise<void>((resolve) => (releaseClose = resolve));
    const reopen = vi.fn();
    const h = renderWidget({
      tasks: [task('a', { content: 'Pay rent' }), task('b', { content: 'Call Sam' })],
      mocks: {
        'POST /api/todoist/tasks/:id/close': async (req: MockRequest) => {
          await closed;
          h.server.tasks = h.server.tasks.filter((t) => t.id !== req.params.id);
          return mockResponse(204);
        },
        'POST /api/todoist/tasks/:id/reopen': (req: MockRequest) => {
          reopen(req.params.id);
          h.server.tasks = [task('a', { content: 'Pay rent' }), ...h.server.tasks];
          return mockResponse(204);
        },
      },
    });

    await user.click(await screen.findByRole('checkbox', { name: 'Complete “Pay rent”' }));
    // Gone before the server has answered.
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Call Sam”']));
    releaseClose();

    // fireEvent (like the UI kit's own toast test): sonner restores focus to the previous element.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith('a'));
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Pay rent”', 'Complete “Call Sam”']));
  });

  it('Undo brings back only that task, not others completed since', async () => {
    const user = userEvent.setup();
    let releaseReopen!: () => void;
    const reopenGate = new Promise<void>((resolve) => (releaseReopen = resolve));
    const h = renderWidget({
      tasks: [task('a', { content: 'Alpha' }), task('b', { content: 'Bravo' }), task('c', { content: 'Charlie' })],
      mocks: {
        'POST /api/todoist/tasks/:id/close': (req: MockRequest) => {
          h.server.tasks = h.server.tasks.filter((t) => t.id !== req.params.id);
          return mockResponse(204);
        },
        'POST /api/todoist/tasks/:id/reopen': async (req: MockRequest) => {
          await reopenGate;
          if (req.params.id === 'a') h.server.tasks = [task('a', { content: 'Alpha' }), ...h.server.tasks];
          return mockResponse(204);
        },
      },
    });

    await user.click(await screen.findByRole('checkbox', { name: 'Complete “Alpha”' }));
    const alphaToast = (await screen.findByText('Completed “Alpha”')).closest('[data-sonner-toast]') as HTMLElement;
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Bravo”', 'Complete “Charlie”']));
    await user.click(screen.getByRole('checkbox', { name: 'Complete “Bravo”' }));
    await screen.findByText('Completed “Bravo”');
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Charlie”']));

    fireEvent.click(within(alphaToast).getByRole('button', { name: 'Undo' }));
    // At once (before the server answered): Alpha is back in its place, Bravo stays done.
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Alpha”', 'Complete “Charlie”']));
    releaseReopen();
    await waitFor(() => expect(h.requestsTo('POST /api/todoist/tasks/a/reopen')).toHaveLength(1));
    await waitFor(() => expect(rowTexts()).toEqual(['Complete “Alpha”', 'Complete “Charlie”']));
  });

  it('puts the task back and reports the error when completing fails', async () => {
    const user = userEvent.setup();
    renderWidget({
      tasks: [task('a', { content: 'Pay rent' })],
      mocks: { 'POST /api/todoist/tasks/:id/close': mockError(502, 'provider_error', 'Todoist is having problems (HTTP 503).') },
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Complete “Pay rent”' }));
    expect(await screen.findByText('Todoist is having problems (HTTP 503).')).toBeInTheDocument();
    expect(rowTexts()).toEqual(['Complete “Pay rent”']);
  });

  it('keeps a recurring task and refetches it with its next date', async () => {
    const user = userEvent.setup();
    const h = renderWidget({
      tasks: [task('r', { content: 'Stretch', due: { date: localDate(0), datetime: null, string: 'every day', isRecurring: true } })],
      mocks: {
        'POST /api/todoist/tasks/:id/close': () => {
          h.server.tasks = [task('r', { content: 'Stretch', due: { date: localDate(1), datetime: null, string: 'every day', isRecurring: true } })];
          return mockResponse(204);
        },
      },
    });
    const checkbox = await screen.findByRole('checkbox', { name: 'Complete “Stretch”' });
    await user.click(checkbox);
    const toastEl = (await screen.findByText('Completed “Stretch”')).closest('[data-sonner-toast]') as HTMLElement;
    expect(within(toastEl).getByText('Next: Tomorrow')).toBeInTheDocument();
    expect(within(toastEl).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(rowTexts()).toEqual(['Complete “Stretch”']);
    expect(within(rows()[0]!).getByText('Tomorrow')).toBeInTheDocument();
  });
});

describe('Todoist widget: recurring completion without a fresh list', () => {
  it('does not claim the old date is the next one when the refetch fails', async () => {
    const user = userEvent.setup();
    let failList = false;
    const recurring = task('r', { content: 'Yoga', due: { date: localDate(0), datetime: null, string: 'every day', isRecurring: true } });
    renderWidget({
      mocks: {
        'GET /api/todoist/tasks': () => (failList ? mockError(502, 'provider_error', 'Todoist is having problems (HTTP 503).') : [recurring]),
        'POST /api/todoist/tasks/:id/close': () => {
          failList = true;
          return mockResponse(204);
        },
      },
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Complete “Yoga”' }));
    const toastEl = (await screen.findByText('Completed “Yoga”')).closest('[data-sonner-toast]') as HTMLElement;
    expect(within(toastEl).getByText('It moves on to its next date.')).toBeInTheDocument();
    expect(within(toastEl).queryByText(/^Next:/)).toBeNull();
  });
});

describe('Todoist widget: quick add', () => {
  it('Enter adds the task, clears the input and refetches', async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    const h = renderWidget({
      tasks: [task('a')],
      mocks: {
        'POST /api/todoist/tasks': (req: MockRequest) => {
          posted.push(req.body);
          const created = task('n', { content: 'Buy milk', due: { date: localDate(1), datetime: null, string: 'tomorrow', isRecurring: false } });
          h.server.tasks = [...h.server.tasks, created];
          return mockResponse(201, created);
        },
      },
    });
    const input = await screen.findByRole('textbox', { name: 'Add a task' });
    await waitFor(() => expect(h.calls).toHaveLength(1));
    await user.type(input, 'Buy milk tomorrow{Enter}');

    await waitFor(() => expect(posted).toEqual([{ text: 'Buy milk tomorrow' }]));
    const toastEl = (await screen.findByText('Added “Buy milk”')).closest('[data-sonner-toast]') as HTMLElement;
    expect(within(toastEl).getByText('Tomorrow')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByRole('checkbox', { name: 'Complete “Buy milk”' })).toBeInTheDocument();
  });

  it('tells when the new task is not part of this list', async () => {
    const user = userEvent.setup();
    renderWidget({
      tasks: [task('a')],
      mocks: { 'POST /api/todoist/tasks': mockResponse(201, task('n', { content: 'Someday thing' })) },
    });
    await user.type(await screen.findByRole('textbox', { name: 'Add a task' }), 'Someday thing{Enter}');
    expect(await screen.findByText("It doesn't match this list's filter.")).toBeInTheDocument();
  });

  it('keeps the text when adding fails; Escape clears it', async () => {
    const user = userEvent.setup();
    renderWidget({ tasks: [], mocks: { 'POST /api/todoist/tasks': mockError(422, 'validation_failed', 'Todoist could not add this task.') } });
    const input = await screen.findByRole('textbox', { name: 'Add a task' });
    await user.type(input, 'Oops{Enter}');
    expect(await screen.findByText('Todoist could not add this task.')).toBeInTheDocument();
    expect(input).toHaveValue('Oops');
    await user.type(input, '{Escape}');
    expect(input).toHaveValue('');
  });

  it('ignores an empty submission', async () => {
    const user = userEvent.setup();
    const h = renderWidget({ tasks: [] });
    await user.type(await screen.findByRole('textbox', { name: 'Add a task' }), '   {Enter}');
    expect(h.requestsTo('POST /api/todoist/tasks')).toHaveLength(0);
  });
});

describe('Todoist widget: sorting', () => {
  const tasks = [
    task('low', { content: 'Low', priority: 1, due: { date: localDate(0), datetime: null, string: '', isRecurring: false } }),
    task('high', { content: 'High', priority: 4, due: { date: localDate(3), datetime: null, string: '', isRecurring: false } }),
    task('none', { content: 'Nodate', priority: 3 }),
  ];

  it.each([
    ['todoist', ['Low', 'High', 'Nodate']],
    ['priority', ['High', 'Nodate', 'Low']],
    ['due', ['Low', 'High', 'Nodate']],
  ] as const)('sort=%s', async (sort, expected) => {
    renderWidget({ tasks, config: { sort } });
    await screen.findByRole('list', { name: 'Tasks' });
    expect(rowTexts()).toEqual(expected.map((name) => `Complete “${name}”`));
  });

  it('the header menu changes the sort through setConfig', async () => {
    const user = userEvent.setup();
    const h = renderWidget({ tasks });
    await screen.findByRole('list', { name: 'Tasks' });
    // Keyboard: the options menu is reachable without a mouse.
    within(actionsHost).getByRole('button', { name: 'Sort and task options' }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: 'Priority' }));
    expect(h.setConfig).toHaveBeenCalledWith({ sort: 'priority' });
  });
});
