import { describe, expect, it } from 'vitest';
import type { Task, TaskDue } from '@homebase/shared';
import { createFormatters } from '../../lib/format.ts';
import {
  DESCRIPTION_PREVIEW_CHARS,
  descriptionPreview,
  dueSortKey,
  dueStatus,
  formatDue,
  listTitle,
  plainTaskText,
  presetFor,
  priorityLabel,
  sortTasks,
} from './model.ts';

const fmt = createFormatters({ locale: 'en-GB', timeFormat: '24h', weekStartsOn: 1 });
/** Friday 25 Sep 2026, 12:00 local time. */
const NOW = new Date(2026, 8, 25, 12, 0, 0);

function due(date: string, extra: Partial<TaskDue> = {}): TaskDue {
  return { date, datetime: null, string: date, isRecurring: false, ...extra };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, content: id, description: '', projectId: 'p', due: null, priority: 1, labels: [], url: `https://app.todoist.com/app/task/${id}`, ...extra };
}

describe('filter presets and titles', () => {
  it('matches presets case- and whitespace-insensitively', () => {
    expect(presetFor('Today  |  OVERDUE')?.label).toBe('Today');
    expect(presetFor('p1')?.label).toBe('Priority 1');
    expect(presetFor('#Work')).toBeUndefined();
  });

  it('uses the custom title, then the preset name, then the query', () => {
    expect(listTitle('  My list ', 'today | overdue')).toBe('My list');
    expect(listTitle(undefined, 'today | overdue')).toBe('Today');
    expect(listTitle('', '#Work & p1')).toBe('#Work & p1');
  });
});

describe('due dates', () => {
  it('classifies full-day dates against the local day', () => {
    expect(dueStatus(due('2026-09-24'), NOW)).toBe('overdue');
    expect(dueStatus(due('2026-09-25'), NOW)).toBe('today');
    expect(dueStatus(due('2026-09-26'), NOW)).toBe('tomorrow');
    expect(dueStatus(due('2026-10-02'), NOW)).toBe('upcoming');
  });

  it('treats a passed time today as overdue and floating times as local wall time', () => {
    expect(dueStatus(due('2026-09-25', { datetime: '2026-09-25T09:00:00' }), NOW)).toBe('overdue');
    expect(dueStatus(due('2026-09-25', { datetime: '2026-09-25T18:00:00' }), NOW)).toBe('today');
    const utcLater = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(dueStatus(due('2026-09-25', { datetime: utcLater }), NOW)).not.toBe('overdue');
  });

  it('formats short, locale-aware labels', () => {
    expect(formatDue(due('2026-09-25'), NOW, fmt)).toBe('Today');
    expect(formatDue(due('2026-09-26'), NOW, fmt)).toBe('Tomorrow');
    expect(formatDue(due('2026-09-24'), NOW, fmt)).toBe('Yesterday');
    expect(formatDue(due('2026-09-29'), NOW, fmt)).toBe('Tuesday');
    expect(formatDue(due('2026-10-12'), NOW, fmt)).toBe('12 Oct');
    expect(formatDue(due('2027-01-03'), NOW, fmt)).toBe('3 Jan 2027');
    expect(formatDue(due('2026-09-25', { datetime: '2026-09-25T17:30:00' }), NOW, fmt)).toBe('17:30');
    expect(formatDue(due('2026-09-26', { datetime: '2026-09-26T09:05:00' }), NOW, fmt)).toBe('Tomorrow 9:05');
  });

  it('follows the 12-hour preference', () => {
    const us = createFormatters({ locale: 'en-US', timeFormat: '12h', weekStartsOn: 0 });
    expect(formatDue(due('2026-09-25', { datetime: '2026-09-25T17:30:00' }), NOW, us)).toMatch(/^5:30\sPM$/);
  });

  it('falls back to the due string for malformed dates', () => {
    expect(formatDue(due('garbage', { string: 'someday' }), NOW, fmt)).toBe('someday');
  });

  it('sorts all-day tasks before timed ones on the same day', () => {
    expect(dueSortKey(due('2026-09-25'))!).toBeLessThan(dueSortKey(due('2026-09-25', { datetime: '2026-09-25T00:30:00' }))!);
    expect(dueSortKey(null)).toBeNull();
  });
});

describe('sortTasks', () => {
  const a = task('a', { priority: 1, due: due('2026-09-27') });
  const b = task('b', { priority: 4, due: due('2026-09-30') });
  const c = task('c', { priority: 2, due: null });
  const d = task('d', { priority: 4, due: due('2026-09-25', { datetime: '2026-09-25T08:00:00' }) });
  const e = task('e', { priority: 1, due: due('2026-09-27') });
  const list = [a, b, c, d, e];

  it('keeps Todoist order', () => {
    expect(sortTasks(list, 'todoist').map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sorts by due date (no date last), then priority, then Todoist order', () => {
    expect(sortTasks(list, 'due').map((t) => t.id)).toEqual(['d', 'a', 'e', 'b', 'c']);
  });

  it('sorts by priority, then due date', () => {
    expect(sortTasks(list, 'priority').map((t) => t.id)).toEqual(['d', 'b', 'c', 'a', 'e']);
  });

  it('does not mutate the input', () => {
    sortTasks(list, 'priority');
    expect(list.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('plain text', () => {
  it('turns markdown links into their label', () => {
    expect(plainTaskText('Read [the RFC](https://example.com/rfc(1)) today')).toBe('Read the RFC today');
    expect(plainTaskText('[](https://example.com)')).toBe('https://example.com');
    expect(plainTaskText('See https://todoist.com (Todoist) now')).toBe('See Todoist now');
  });

  it('drops emphasis and code markers but keeps ordinary asterisks', () => {
    expect(plainTaskText('**Bold** and *italic* and __under__ and `code` and ~~gone~~')).toBe('Bold and italic and under and code and gone');
    expect(plainTaskText('Compute 5 * 3 * 2')).toBe('Compute 5 * 3 * 2');
    expect(plainTaskText('snake_case_name stays')).toBe('snake_case_name stays');
  });

  it('never produces markup from HTML-looking content (it stays text)', () => {
    expect(plainTaskText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('previews the first non-empty description line', () => {
    expect(descriptionPreview('\n\n  First [line](https://x.y)\nSecond')).toBe('First line');
    expect(descriptionPreview('   ')).toBe('');
    expect(descriptionPreview(`${'word '.repeat(200)}\nnext`)).toHaveLength(DESCRIPTION_PREVIEW_CHARS - 1);
  });

  it('stays fast on hostile text (shared-project collaborators can write it)', () => {
    // A run of brackets used to cost O(n²) regex steps per row on every render.
    const started = performance.now();
    expect(descriptionPreview('['.repeat(16_000))).toBe('['.repeat(DESCRIPTION_PREVIEW_CHARS));
    for (let i = 0; i < 50; i++) plainTaskText(`${'['.repeat(1000)}${'[a](x'.repeat(200)}`);
    expect(performance.now() - started).toBeLessThan(150);
    // Labels with brackets are left as typed (rare; still plain text).
    expect(plainTaskText('[[nested]](https://x.y) and [a](b)')).toBe('[[nested]](https://x.y) and a');
  });

  it('labels priorities the way Todoist users read them', () => {
    expect(priorityLabel(4)).toBe('Priority 1');
    expect(priorityLabel(1)).toBe('Priority 4');
  });
});
