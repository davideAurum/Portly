import { describe, expect, it } from 'vitest';
import { MIGRATED_FLAG_KEY, copyLegacyLocalStorage } from './legacyStorage.ts';

/** A Storage over a Map (insertion order, like the browser's for these tests). */
function memoryStorage(initial: Record<string, string> = {}, { failWrites = false } = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
}

describe("copying Homebase's browser settings (before the rename to Portly)", () => {
  it('copies every homebase: key to its portly: key, except cached query snapshots', () => {
    const storage = memoryStorage({
      'homebase:pairing:/': '{"token":"t","instanceId":"i","pairedAt":1}',
      'homebase:backend-mode:/': 'server',
      'homebase:weather:device-location': '{"lat":1,"lon":2}',
      'homebase:query-cache:static:/': '{"big":"snapshot"}',
      'other-app:key': 'x',
    });
    expect(copyLegacyLocalStorage(storage)).toBe(3);
    expect(storage.getItem('portly:pairing:/')).toBe('{"token":"t","instanceId":"i","pairedAt":1}');
    expect(storage.getItem('portly:backend-mode:/')).toBe('server');
    expect(storage.getItem('portly:weather:device-location')).toBe('{"lat":1,"lon":2}');
    expect(storage.getItem('portly:query-cache:static:/')).toBeNull();
    expect(storage.getItem('homebase:pairing:/'), 'the old keys stay').not.toBeNull();
    expect(storage.getItem(MIGRATED_FLAG_KEY)).not.toBeNull();
  });

  it("never overwrites a key Portly already has", () => {
    const storage = memoryStorage({ 'homebase:backend-mode:/': 'server', 'portly:backend-mode:/': 'browser' });
    expect(copyLegacyLocalStorage(storage)).toBe(0);
    expect(storage.getItem('portly:backend-mode:/')).toBe('browser');
  });

  it('runs once: a key Portly removed later is not brought back', () => {
    const storage = memoryStorage({ 'homebase:pairing:/': 'old' });
    expect(copyLegacyLocalStorage(storage)).toBe(1);
    storage.removeItem('portly:pairing:/'); // disconnected
    expect(copyLegacyLocalStorage(storage)).toBe(0);
    expect(storage.getItem('portly:pairing:/')).toBeNull();
  });

  it('tolerates missing or failing storage (and tries again next time)', () => {
    expect(copyLegacyLocalStorage(null)).toBe(0);
    const full = memoryStorage({ 'homebase:pairing:/': 'old' }, { failWrites: true });
    expect(copyLegacyLocalStorage(full)).toBe(0);
    expect(full.getItem(MIGRATED_FLAG_KEY)).toBeNull();
  });
});
