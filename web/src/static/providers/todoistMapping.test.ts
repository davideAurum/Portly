/** Todoist v1 → contract mapping (copy of server/src/modules/todoist/mapping.test.ts). */
import { describe, expect, it } from 'vitest';
import { upstreamDue, upstreamProject, upstreamTask } from './__fixtures__/todoist.ts';
import { MAX_CONTENT_CHARS, dateInZone, mapDue, mapProject, mapProjects, mapTask, mapTasks } from './todoistMapping.ts';

describe('todoist mapping: due dates', () => {
  it('maps a full-day date', () => {
    expect(mapDue(upstreamDue('2026-09-25', { string: 'tomorrow' }))).toEqual({
      date: '2026-09-25',
      datetime: null,
      string: 'tomorrow',
      isRecurring: false,
    });
  });

  it('maps a floating date-time (no zone) and keeps it floating', () => {
    expect(mapDue(upstreamDue('2026-09-25T17:30:00', { string: 'tomorrow 5:30pm' }))).toEqual({
      date: '2026-09-25',
      datetime: '2026-09-25T17:30:00',
      string: 'tomorrow 5:30pm',
      isRecurring: false,
    });
  });

  it('maps a fixed UTC date-time to the calendar day of the task zone', () => {
    // 23:30 UTC on the 25th is already the 26th in Berlin (UTC+2 in September).
    const due = mapDue(upstreamDue('2026-09-25T23:30:00Z', { timezone: 'Europe/Berlin', string: 'every day 1:30am', is_recurring: true }));
    expect(due).toEqual({ date: '2026-09-26', datetime: '2026-09-25T23:30:00Z', string: 'every day 1:30am', isRecurring: true });
    // Without (or with an unknown) zone the UTC date part is used.
    expect(mapDue(upstreamDue('2026-09-25T23:30:00Z'))?.date).toBe('2026-09-25');
    expect(mapDue(upstreamDue('2026-09-25T23:30:00Z', { timezone: 'Not/AZone' }))?.date).toBe('2026-09-25');
  });

  it('honours a REST-style datetime field next to a date', () => {
    expect(mapDue({ date: '2026-09-25', datetime: '2026-09-25T09:00:00Z', string: '', is_recurring: false })).toMatchObject({
      date: '2026-09-25',
      datetime: '2026-09-25T09:00:00Z',
    });
  });

  it('passes is_recurring through faithfully (the web relies on it after close)', () => {
    expect(mapDue(upstreamDue('2026-09-25', { is_recurring: true }))?.isRecurring).toBe(true);
    expect(mapDue(upstreamDue('2026-09-25', { is_recurring: null }))?.isRecurring).toBe(false);
    expect(mapDue({ date: '2026-09-25' })?.isRecurring).toBe(false);
  });

  it('rejects malformed dates', () => {
    expect(mapDue(upstreamDue('tomorrow'))).toBeNull();
    expect(mapDue(upstreamDue('2026-02-30'))).toBeNull();
    expect(mapDue(upstreamDue('2026-09-25T25:00:00'))).toBeNull();
    expect(mapDue({ string: 'x' })).toBeNull();
    expect(mapDue(null)).toBeNull();
  });

  it('dateInZone formats an instant in an IANA zone', () => {
    expect(dateInZone('2026-09-25T02:00:00Z', 'America/Los_Angeles')).toBe('2026-09-24');
    expect(dateInZone('garbage', 'UTC')).toBeNull();
  });
});

describe('todoist mapping: tasks', () => {
  it('maps a v1 task to the Task contract', () => {
    const raw = upstreamTask({
      id: 'abc123XYZ',
      content: 'Buy [milk](https://example.com/milk)',
      description: 'Semi-skimmed',
      project_id: 'proj1',
      due: upstreamDue('2026-09-25T17:00:00', { string: 'today 5pm' }),
      priority: 4,
      labels: ['errand', 'errand', ' home ', '', 42],
    });
    expect(mapTask(raw)).toEqual({
      id: 'abc123XYZ',
      content: 'Buy [milk](https://example.com/milk)',
      description: 'Semi-skimmed',
      projectId: 'proj1',
      due: { date: '2026-09-25', datetime: '2026-09-25T17:00:00', string: 'today 5pm', isRecurring: false },
      priority: 4,
      labels: ['errand', 'home'],
      url: 'https://app.todoist.com/app/task/abc123XYZ',
    });
  });

  it('accepts legacy numeric ids and fills defaults', () => {
    const task = mapTask({ id: 2995104339, content: 'Old', priority: 9, labels: null, description: null, project_id: 220474322 });
    expect(task).toMatchObject({ id: '2995104339', projectId: '220474322', priority: 4, labels: [], description: '', due: null });
  });

  it('clamps priority and caps text', () => {
    expect(mapTask(upstreamTask({ priority: 0 }))?.priority).toBe(1);
    expect(mapTask(upstreamTask({ priority: 'high' }))).toBeNull();
    const long = mapTask(upstreamTask({ content: 'x'.repeat(MAX_CONTENT_CHARS + 50) }));
    expect(long?.content).toHaveLength(MAX_CONTENT_CHARS);
  });

  it('drops malformed, completed, deleted and oddly-identified tasks', () => {
    const { tasks, skipped } = mapTasks([
      upstreamTask({ id: 'good1' }),
      upstreamTask({ checked: true }),
      upstreamTask({ is_deleted: true }),
      upstreamTask({ id: '../../etc' }),
      upstreamTask({ content: undefined }),
      'nonsense',
      null,
      upstreamTask({ id: 'good2', due: upstreamDue('not a date') }),
    ]);
    expect(tasks.map((t) => t.id)).toEqual(['good1', 'good2']);
    expect(tasks[1]?.due).toBeNull();
    expect(skipped).toBe(6);
  });

  it('drops project ids that are not plain ids (hostile or oversized)', () => {
    expect(mapTask(upstreamTask({ project_id: 'x'.repeat(100_000) }))?.projectId).toBe('');
    expect(mapTask(upstreamTask({ project_id: '../inbox' }))?.projectId).toBe('');
    expect(mapTask(upstreamTask({ project_id: null }))?.projectId).toBe('');
    expect(mapTask(upstreamTask({ project_id: '6Jf8VQXxpwv56VQ7' }))?.projectId).toBe('6Jf8VQXxpwv56VQ7');
  });

  it('url-encodes ids in the task URL', () => {
    expect(mapTask(upstreamTask({ id: 'a_b-C9' }))?.url).toBe('https://app.todoist.com/app/task/a_b-C9');
  });
});

describe('todoist mapping: projects', () => {
  it('maps names and palette colors to hex', () => {
    expect(mapProject(upstreamProject({ id: 'p1', name: 'Inbox', color: 'berry_red' }))).toEqual({ id: 'p1', name: 'Inbox', color: '#b8255f' });
    expect(mapProject(upstreamProject({ id: 'p2', color: 'not_a_color' }))?.color).toBeNull();
    expect(mapProject(upstreamProject({ id: 'p3', color: '#ff0000' }))?.color).toBeNull();
  });

  it('skips archived, deleted and malformed projects', () => {
    const list = mapProjects([
      upstreamProject({ id: 'keep' }),
      upstreamProject({ is_archived: true }),
      upstreamProject({ is_deleted: true }),
      { id: 'x' },
      upstreamProject({ id: 'a/b' }),
      upstreamProject({ id: 'y'.repeat(65) }),
      42,
    ]);
    expect(list.map((p) => p.id)).toEqual(['keep']);
  });
});
