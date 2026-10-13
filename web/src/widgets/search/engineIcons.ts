/**
 * Search engine icons: engines without `iconId` get the favicon of their site through
 * `GET /api/site-meta` (the server resolves and stores it), and the found ids are saved in one
 * settings update. Runs from every search box and from Settings → Search (shared bookkeeping, so
 * they never fetch the same engine twice at once), and only while
 * `settings.bookmarks.autoFetchIcons` is on. Bookkeeping is per engine *and site*: an engine whose
 * address moves to another site, or that lost its icon (reset to presets), is looked up again;
 * a site without an icon is not retried during this page load. Failures are silent: engines keep
 * their letter tile.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SearchSettingsSchema, type SearchEngine, type SearchSettings, type Settings } from '@homebase/shared';
import { fetchSiteMeta } from '../../api/bookmarks.ts';
import { qk } from '../../api/keys.ts';
import { patchSettings } from '../../api/settings.ts';

/** Site lookups running at once (first run looks up every preset engine). */
export const ENGINE_ICON_CONCURRENCY = 3;

/** `${engineId} ${site}` pairs that have no icon (not retried during this page load). */
const missed = new Set<string>();
/** Lookups in flight, by mark → the effect run that owns them. */
const inflight = new Map<string, object>();

/** Site root of an engine's URL template (`https://www.google.com/`), or null. */
export function engineSite(engine: Pick<SearchEngine, 'urlTemplate'>): string | null {
  try {
    return `${new URL(engine.urlTemplate.replace(/%s/g, 'x')).origin}/`;
  } catch {
    return null;
  }
}

export function useEngineIcons(search: SearchSettings | undefined, enabled: boolean): void {
  const client = useQueryClient();
  const key = (search?.engines ?? [])
    .filter((e) => e.iconId === null)
    .map((e) => `${e.id} ${e.urlTemplate}`)
    .join('\n');

  useEffect(() => {
    if (!enabled || key === '') return;
    const todo = key
      .split('\n')
      .map((line) => {
        const space = line.indexOf(' ');
        const id = line.slice(0, space);
        const site = engineSite({ urlTemplate: line.slice(space + 1) });
        return { id, site, mark: `${id} ${site ?? ''}` };
      })
      .filter((e) => !missed.has(e.mark) && !inflight.has(e.mark));
    if (todo.length === 0) return;
    const controller = new AbortController();
    const run = {};
    const release = (mark: string) => {
      if (inflight.get(mark) === run) inflight.delete(mark);
    };
    for (const e of todo) inflight.set(e.mark, run);

    void (async () => {
      const found = new Map<string, string>();
      // One lookup per site (Google and Google Maps share one), a few at a time.
      const bySite = new Map<string | null, typeof todo>();
      for (const engine of todo) bySite.set(engine.site, [...(bySite.get(engine.site) ?? []), engine]);
      const sites = [...bySite.entries()];
      const lookUp = async ([site, engines]: (typeof sites)[number]): Promise<void> => {
        try {
          const meta = site ? await fetchSiteMeta(site, controller.signal) : null;
          for (const engine of engines) {
            if (meta?.iconId) found.set(engine.id, meta.iconId);
            else missed.add(engine.mark);
          }
        } catch {
          if (!controller.signal.aborted) for (const engine of engines) missed.add(engine.mark);
        } finally {
          for (const engine of engines) release(engine.mark);
        }
      };
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < sites.length && !controller.signal.aborted) await lookUp(sites[next++]!);
      };
      await Promise.all(Array.from({ length: Math.min(ENGINE_ICON_CONCURRENCY, sites.length) }, worker));
      for (const engine of todo) release(engine.mark);
      if (found.size === 0) return;
      const latest = client.getQueryData<Settings>(qk.settings())?.search;
      if (!latest || !latest.engines.some((e) => found.has(e.id) && e.iconId === null)) return;
      const engines = latest.engines.map((e) => (found.has(e.id) && e.iconId === null ? { ...e, iconId: found.get(e.id)! } : e));
      if (!SearchSettingsSchema.safeParse({ ...latest, engines }).success) return;
      try {
        client.setQueryData(qk.settings(), await patchSettings({ search: { engines } }));
      } catch {
        // Icons are cosmetic; the next change or load tries again.
      }
    })();
    return () => {
      controller.abort();
      // A re-run (StrictMode, remount, another engine changed) takes over the unfinished lookups.
      for (const engine of todo) release(engine.mark);
    };
  }, [client, enabled, key]);
}
