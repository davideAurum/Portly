import { describe, expect, it } from 'vitest';
import { UpdateRunSchema, isUpdateRunActive } from './update.ts';

describe('UpdateRunSchema', () => {
  const run = {
    id: 'run-1',
    state: 'done',
    from: '0.2.0-alpha.7',
    to: '0.2.0-alpha.8',
    startedAt: '2026-11-05T10:00:00.000Z',
    finishedAt: '2026-11-05T10:01:00.000Z',
    code: null,
    extensionChanged: false,
  };

  it('accepts a run and tells finished states from active ones', () => {
    expect(UpdateRunSchema.parse(run).state).toBe('done');
    expect(isUpdateRunActive({ state: 'restarting' })).toBe(true);
    expect(isUpdateRunActive({ state: 'rolled-back' })).toBe(false);
  });

  it('has no room for free text: an unknown code or an extra field is refused', () => {
    expect(UpdateRunSchema.safeParse({ ...run, code: 'C:\\Users\\you' }).success).toBe(false);
    expect(UpdateRunSchema.safeParse({ ...run, message: 'C:\\Users\\you' }).success).toBe(false);
  });
});
