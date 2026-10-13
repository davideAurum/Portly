import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@homebase/shared';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { createMemoryLogger } from './logger.ts';
import { createSettingsService } from './settings.ts';

describe('SettingsService', () => {
  let db: Db;
  let log: ReturnType<typeof createMemoryLogger>;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    log = createMemoryLogger();
  });
  afterEach(() => db.close());

  it('returns defaults when nothing is stored', () => {
    const s = createSettingsService({ db, log });
    expect(s.getAll()).toEqual(defaultSettings());
    expect(s.get('calendar').syncIntervalMin).toBe(5);
    expect(s.get('activeProfileId')).toBeNull();
  });

  it('reads stored namespaces and falls back per namespace on invalid rows', () => {
    db.run('INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?)', ['general', '{"userName":"Dana"}', 1]);
    db.run('INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?)', ['calendar', '{"syncIntervalMin":999}', 1]);
    db.run('INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?)', ['todoist', 'not json', 1]);
    db.run('INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?)', ['activeProfileId', '"p1"', 1]);
    const s = createSettingsService({ db, log });
    expect(s.get('general').userName).toBe('Dana');
    expect(s.get('general').timeFormat).toBe('system');
    expect(s.get('calendar')).toEqual({ syncIntervalMin: 5, defaultCalendarId: null });
    expect(s.get('todoist').defaultFilter).toBe('today | overdue');
    expect(s.get('activeProfileId')).toBe('p1');
    expect(log.lines.filter((l) => l.level === 'warn').map((l) => l.fields?.namespace).sort()).toEqual(['calendar', 'todoist']);
  });

  it('warns once per namespace (with a fingerprint, not the content) and heals a corrupt row with the next write (LOG-1)', () => {
    db.run('INSERT INTO settings (namespace, value, updated_at) VALUES (?, ?, ?)', ['search', '{not json', 1]);
    const s = createSettingsService({ db, log });
    s.get('search');
    s.reload();
    s.get('search');
    const warns = log.lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ namespace: 'search', length: 9, sha1: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(JSON.stringify(warns[0])).not.toContain('{not json');
    // An import (or any write) carrying the defaults for that namespace writes them.
    s.replace(s.getAll());
    expect(JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE namespace = 'search'")!.value)).toEqual(s.get('search'));
    createSettingsService({ db, log }).get('search');
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  it('replace() validates, persists only changed namespaces and notifies listeners', () => {
    const s = createSettingsService({ db, log, now: () => 42 });
    const onCalendar = vi.fn();
    const onGeneral = vi.fn();
    s.onChange('calendar', onCalendar);
    const unsubscribe = s.onChange('general', onGeneral);
    unsubscribe();

    const next = { ...s.getAll(), calendar: { syncIntervalMin: 15, defaultCalendarId: null } };
    s.replace(next);
    expect(onCalendar).toHaveBeenCalledWith({ syncIntervalMin: 15, defaultCalendarId: null }, { syncIntervalMin: 5, defaultCalendarId: null });
    expect(onGeneral).not.toHaveBeenCalled();
    expect(db.all('SELECT namespace, value, updated_at FROM settings')).toEqual([
      { namespace: 'calendar', value: '{"syncIntervalMin":15,"defaultCalendarId":null}', updated_at: 42 },
    ]);
    expect(createSettingsService({ db, log }).get('calendar').syncIntervalMin).toBe(15);
  });

  it('replace() and set() reject invalid settings with 422 without writing', () => {
    const s = createSettingsService({ db, log });
    const invalid = expect.objectContaining({ status: 422, code: 'validation_failed' });
    expect(() => s.replace({ ...s.getAll(), calendar: { syncIntervalMin: 1 } })).toThrow(invalid);
    expect(() => s.set('general', { bogus: true })).toThrow(invalid);
    expect(db.all('SELECT * FROM settings')).toEqual([]);
  });

  it('hands out deeply frozen values, so callers cannot corrupt the cache', () => {
    const s = createSettingsService({ db, log });
    const all = s.getAll();
    expect(Object.isFrozen(all)).toBe(true);
    expect(() => {
      (s.get('search').engines as { name: string }[])[0]!.name = 'Hijacked';
    }).toThrow(TypeError);
    expect(() => {
      (s.get('general') as { userName?: string }).userName = 'Eve';
    }).toThrow(TypeError);
    expect(s.getAll()).toEqual(defaultSettings());

    const onGeneral = vi.fn((value: { userName?: string }) => {
      expect(Object.isFrozen(value)).toBe(true);
    });
    s.onChange('general', onGeneral);
    const next = s.patch({ general: { userName: 'Dana' } });
    expect(Object.isFrozen(next.general)).toBe(true);
    expect(onGeneral).toHaveBeenCalledTimes(1);
    // Editing a clone is the supported way to build the next value.
    const draft = structuredClone(s.getAll());
    draft.general.userName = 'Sam';
    expect(s.replace(draft).general.userName).toBe('Sam');
  });

  describe('patch() (RFC 7396)', () => {
    it('merges objects, replaces arrays and resets null keys to defaults', () => {
      const s = createSettingsService({ db, log });
      const onGeneral = vi.fn();
      s.onChange('general', onGeneral);

      const a = s.patch({ general: { userName: 'Dana', timeFormat: '24h' }, appearance: { accent: '#112233' } });
      expect(a.general).toMatchObject({ userName: 'Dana', timeFormat: '24h', locale: 'system' });
      expect(a.appearance.accent).toBe('#112233');
      expect(a.appearance.mode).toBe('system');
      expect(onGeneral).toHaveBeenCalledTimes(1);

      const engines = [{ id: 'mine', name: 'Mine', urlTemplate: 'https://search.example/?q=%s' }];
      const b = s.patch({ search: { engines, defaultEngineId: 'mine' } });
      expect(b.search.engines).toEqual([{ ...engines[0], keyword: null, suggest: null, iconId: null }]);

      const c = s.patch({ general: { userName: null }, search: null, appearance: { accent: null } });
      expect(c.general.userName).toBeUndefined();
      expect(c.general.timeFormat).toBe('24h');
      expect(c.search).toEqual(defaultSettings().search);
      expect(c.appearance.accent).toBe(defaultSettings().appearance.accent);
      expect(createSettingsService({ db, log }).getAll()).toEqual(c);
    });

    it('switches the background variant when the old variant keys are nulled', () => {
      const s = createSettingsService({ db, log });
      const next = s.patch({ appearance: { background: { type: 'color', color: '#000000', angle: null, stops: null } } });
      expect(next.appearance.background).toEqual({ type: 'color', color: '#000000' });
      expect(s.patch({ appearance: { background: null } }).appearance.background).toEqual(defaultSettings().appearance.background);
    });

    it('rejects invalid results with 422 and writes nothing', () => {
      const s = createSettingsService({ db, log });
      for (const patch of [
        { general: { timeFormat: '13h' } },
        { general: { bogus: true } },
        { appearance: { accent: 'red; background:url(x)' } },
        { calendar: { syncIntervalMin: 1 } },
        { unknownNamespace: {} },
        { appearance: { background: { type: 'image', uploadId: 'not-a-uuid' } } },
      ]) {
        expect(() => s.patch(patch), JSON.stringify(patch)).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed' }));
      }
      expect(db.all('SELECT * FROM settings')).toEqual([]);
      expect(s.getAll()).toEqual(defaultSettings());
    });

    it('rejects non-object patches with 400', () => {
      const s = createSettingsService({ db, log });
      for (const patch of [null, [], 'x', 42, true]) {
        expect(() => s.patch(patch)).toThrow(expect.objectContaining({ status: 400, code: 'bad_request' }));
      }
    });

    it('rejects prototype-pollution payloads at any depth (400) without polluting', () => {
      const s = createSettingsService({ db, log });
      for (const text of [
        '{"__proto__":{"polluted":true}}',
        '{"general":{"__proto__":{"polluted":true}}}',
        '{"constructor":{"prototype":{"polluted":true}}}',
        '{"appearance":{"background":{"stops":[{"__proto__":{"polluted":true}}]}}}',
        '{"search":{"engines":[{"prototype":1}]}}',
      ]) {
        expect(() => s.patch(JSON.parse(text)), text).toThrow(expect.objectContaining({ status: 400 }));
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
      expect(db.all('SELECT * FROM settings')).toEqual([]);
    });

    it('never mutates the cached settings object it merges from', () => {
      const s = createSettingsService({ db, log });
      const before = s.getAll();
      const snapshot = structuredClone(before);
      expect(() => s.patch({ general: { timeFormat: 'bad' } })).toThrow();
      expect(before).toEqual(snapshot);
    });
  });

  it('set() replaces one namespace; listener errors are contained', () => {
    const s = createSettingsService({ db, log });
    s.onChange('activeProfileId', () => {
      throw new Error('listener bug');
    });
    expect(s.set('activeProfileId', 'p9')).toBe('p9');
    expect(s.get('activeProfileId')).toBe('p9');
    expect(log.lines.some((l) => l.level === 'error' && l.message === 'settings listener failed')).toBe(true);
  });
});
