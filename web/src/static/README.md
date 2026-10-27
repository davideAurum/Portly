# The static backend (`web/src/static/`)

The browser-only build (`npm run build:static`, Vite mode `static`) has no Portly server of its
own. This folder is the replacement: an in-browser backend that answers the same `/api/*` calls the
web app makes, over IndexedDB instead of SQLite, with real `Response` objects, so the rest of the app
is unchanged. User guide: [docs/setup/static-build.md](../../../docs/setup/static-build.md).

In hybrid mode (`web/src/localServer/`) a page load of this build may use the Portly server on
this PC instead — then this folder is never loaded (IndexedDB is not even opened). Each page load
has one backend, `browser` (this folder) or `server`, fixed before the first render; switching
reloads the page. Guide: [docs/setup/pages-local-server.md](../../../docs/setup/pages-local-server.md).

## How a request flows

```text
useQuery / useMutation
  -> web/src/api/*.ts            unchanged
  -> api() in api/client.ts      if __PORTLY_STATIC__: pagesFetch(path, init) instead of fetch()
  -> localServer/transport.ts    pagesFetch: this page load's backend decides
       browser backend:          staticFetch(path, init) from backend.ts (dynamic import)
       server backend:           the Portly server on this PC (paired CORS request; not this folder)
  -> backend.ts dispatch()       builds a Request, matches METHOD + pathname in the router
  -> handlers/<module>.ts        reads/writes slices on ctx.state, returns a Response (respond.ts)
  <- api()                       same error mapping, 204 handling and JSON parsing as the server build
```

`__PORTLY_STATIC__` is a Vite `define` (true only in the static build). `client.ts` imports
`localServer/transport.ts` dynamically, and the transport imports `backend.ts` dynamically, so
neither the transport nor this folder lands in the server build's bundle, and a server-backend page
of the static build never loads this folder. Everywhere else, UI code reads `getCapabilities()` from
`src/capabilities.ts` at render or call time (never at module top level): "the data lives in this
browser" is `getCapabilities().backend === 'browser'`, not the build flag. Tests switch with
`setCapabilitiesForTests(capabilitiesFor(true, 'browser' | 'server'))`, not `vi.mock`.

## Files

| File | What it is |
| --- | --- |
| `backend.ts` | `createStaticBackend({storage, ...})` → `{ctx, router, fetch, onExternalChange, close}`; `dispatch()` (route match, `StaticApiError` → response, any other throw → `500 internal`, the caller's own `AbortError` rethrown); `ensureStaticBackend()` / `staticFetch()` for the page (IndexedDB, or memory when it cannot be opened). |
| `router.ts` | `StaticRouter`: `get/post/put/patch/delete('/api/path/:param', handler)`. Exact segment-count matching, `:param` segments percent-decoded, HEAD matches GET, no wildcards. `match()`, `hasPath()` (wrong method → `400`), `list()`. |
| `respond.ts` | `json(body, status)`, `noContent()` (204), `apiError(code, message, details?)` with the status from `ERROR_STATUS`, `StaticApiError` (throw it from a handler), `validationError(zodError)` (422 with `{path, message, code}` details), `notFound()`, `unavailable(feature)` (409 `not_configured`), `readJson(req)`, `readFormData(req)`. |
| `context.ts` | `StaticContext {state, assets, version, now(), newId(), appUrl, notify?}` — always use `ctx.now()` / `ctx.newId()`; tests inject them. `notify(keys)` tells this page's app that background work changed slices (as another tab's change is told). |
| `state.ts` | `StaticState`: named JSON slices with write-through persistence. `get(name, init)` returns the live object (mutate it), `set`, `commit(...names)` (persists and tells other tabs over `BroadcastChannel('portly-static:<base path>')`; on a failed write memory is restored from the last persisted copy), `commitWith` (slices + blob writes in one transaction), `settled()`, `remove`, `reload`, `clearAll`, blob helpers. |
| `slices.ts` | The slice names (`SLICE.*`) and stored shapes shared by every handler, with accessors (`getSettings`, `getProfiles`, `getBookmarks`, `getUploads`, `getIcons`, `getTodoistToken`, `getGitHubSync` (the GitHub sync repository and token, never exported), `getBackups`, `getAccounts`, `getAccountTokens`, `getCalendars`, `getCalendarEvents`, `getCalendarSync`, `getUpgrades` (one-time data upgrades already applied, never exported), …) and limits (`ORPHAN_GRACE_MS`, `MAX_BACKUPS`). Do not invent other slice names. |
| `storage/types.ts` | `StaticStorage` (JSON by key + `StoredBlob` by id) and `StoredBlob {id, kind: 'upload' \| 'icon', type, bytes: Uint8Array, width, createdAt}` — bytes, never `Blob` (Safari private mode, test realms); `blobOf(entry)` makes a Blob when needed. |
| `storage/idb.ts` | IndexedDB implementation: database `portly-static:<base path>` (e.g. `portly-static:/`), stores `kv` and `blobs`; `applyBatch` writes JSON and blobs in one transaction. |
| `storage/memory.ts` | In-memory implementation (tests; fallback when IndexedDB is unavailable). |
| `assets.ts` | What an app image URL (`/api/icons/<id>`, `/api/uploads/<id>`) becomes on this page load: identity in the server build; on the browser backend the `AssetRegistry`'s `blob:` object URL (or an external https URL); on the server backend (hybrid mode) the image loaded from Portly on this PC by the `ServerAssetSource` (`localServer/assets.ts`), and **no URL until it is loaded** (never the raw `/api/…` path). Components use `useAssetUrl(url)` (follows loading; null → show the placeholder), other code `getAssetUrl` / `loadAssetUrl`; `resolveAssetUrl` is for callers that need a string at once (a transparent pixel until loaded). `subscribeAssets` hears about every change. |
| `favicon.ts` | Synthetic bookmark icon ids `fav:<host>` → DuckDuckGo's icon service; local-looking hosts never get one. |
| `oauthRedirect.ts` | The page side of the Microsoft sign-in. `finishSignIn` completes it when Microsoft sends the browser back with `?code&state` (called from `main.tsx` before the app renders) and keeps the code out of the address bar and history; `planAutomaticSignIn` starts a `prompt=none` sign-in at page load when an account's sign-in has ended or is about to. |
| `handlers/index.ts` | `HandlerModule {register(router), ready?(ctx)}` and the `MODULES` list, in the server's route order. |
| `handlers/core.ts` | `GET /api/health`, `GET /api/about` (the example module). |
| `handlers/settings.ts` | `GET` / `PATCH /api/settings` (merge patch, `activeProfileId` checks); `ready()` moves stored pre-Beacon appearance defaults to the new ones once (the server's `004_beacon_defaults.sql`). |
| `handlers/profiles.ts` | `/api/profiles` (list, create, `PATCH` name/sort, delete, `activate`), `PUT …/:id/positions`, `…/:id/widgets[/:instanceId]` (add, patch, remove). An empty list on first run lets the web app's seed create the default profile. |
| `handlers/uploads.ts` | `POST /api/uploads`, `GET /api/uploads/:id` (sniffed image bytes in the blob store); orphan pruning and object-URL registration in `ready()`. |
| `handlers/transfer.ts` | `GET /api/export`, `POST /api/import/preview`, `POST /api/import/commit` (the export file format), plus the static build's pre-import backups (`GET /api/backups`, `GET /api/backups/:id`). |
| `handlers/bookmarks.ts` | `/api/bookmarks`, `/api/bookmark-groups` (CRUD, reorder, move), `…/:id/icon` and `…/:id/refresh-icon`, `GET /api/icons/:id`, `POST /api/bookmarks/import/html`; `GET /api/site-meta` answers from the URL alone (host-derived title, automatic icon id, no page fetch); `GET /api/bookmarks/import/sources` is `[]` and `POST …/import/browser` a `404` (no browser-profile import here). Icon cleanup and object URLs in `ready()`. |
| `handlers/bookmarkImport.ts` | No routes: writes an imported bookmark tree into the bookmarks slice (the server's `writeImport`), used by `bookmarks.ts`. |
| `handlers/search.ts` | `GET /api/search/suggest` (Wikipedia only; `[]` for the other providers). |
| `handlers/weather.ts` | `GET /api/weather`, `GET /api/weather/geocode` (Open-Meteo, cached), `GET /api/weather/place` (Nominatim reverse geocoding, `providers/nominatim.ts`, cached 7 days). |
| `handlers/sports.ts` | `GET /api/sports/teams?league=`, `GET /api/sports/games?league=&team=` (ESPN's public site API, called from the browser; cached in memory, failures never cached). |
| `handlers/todoist.ts` | `GET` / `PUT` / `DELETE /api/todoist/token`, `/api/todoist/tasks` (list, create, patch, `close`, `reopen`), `GET /api/todoist/projects`. |
| `handlers/accounts.ts` | Outlook.com accounts with the browser as the OAuth client (PKCE, single-page-app registration, no secret): `/api/oauth-clients/microsoft`, `POST /api/oauth/microsoft/start`, `/api/accounts` (list, `PATCH`, `DELETE` — its calendars go with it — and `…/test`); `getAccessToken()` (refresh under a Web Lock per account) for the calendar's Graph calls. Google answers `409 not_configured`. |
| `handlers/calendar.ts` | Outlook.com calendars, synced from Microsoft Graph by the browser: `/api/calendar/calendars` (list, `PATCH`; `DELETE` is a `409`), `GET /api/calendar/events`, `POST`/`PATCH`/`DELETE /api/calendar/events[/:id]` (written through to Graph), `POST /api/calendar/sync`. No background job: the calendar and events requests sync the accounts that are due (`settings.calendar.syncIntervalMin`) and wait for it (at most 15 s; a longer sync tells the app through `ctx.notify` when it is done); tabs take turns with a Web Lock per account and re-read the stored sync time first. Backoff as on the server (403/404 per calendar, rate limits per account). |
| `handlers/githubSync.ts` | `GET` / `PUT` / `DELETE /api/sync/github`: the private repository (`owner/name`) and fine-grained token for launch pad sync, write-only (`{configured}`), checked with GitHub before they are saved. Browser backend only; nothing syncs yet. |
| `sync/store.ts` | `SyncStore`, the interface every launch pad sync backend implements (OneDrive, GitHub): read and write the main file with a version check, create-only icons, `SyncStoreError` codes and the size caps. |
| `handlers/unavailable.ts` | Every server-only route (app-password accounts, the vault, ICS subscriptions, mail, feeds, the server's diagnostics) → `409 not_configured`, rendered as "Not set up yet". |
| `providers/` | Outbound clients the handlers call from the browser: `openMeteo.ts` (forecast and geocoding requests, mappers, query schemas), `suggest.ts` (suggestion URL builder with Wikipedia's `origin=*`, parser), `todoistClient.ts` (Todoist API v1 over `fetch`, error mapping), `todoistMapping.ts` (Todoist objects → shared contracts), `todoistToken.ts` (the token slice), `githubRepo.ts` (launch pad sync through a private repository: a `SyncStore` over the contents API of `api.github.com`, docs/design/launchpad-sync-github.md), `githubSync.ts` (the repository and token: shape checks, the check with GitHub, the slice, `openGitHubStore`), `microsoftAuth.ts` (Microsoft sign-in: authorize URL, token endpoint, id_token checks), `graphCalendar.ts` (Microsoft Graph calendar/event mapping and write bodies), `graphClient.ts` (Graph calls with the account's token: one refresh-and-retry on 401, the server's error mapping, paged listings, event writes), `espn.ts` (ESPN responses → the shared sports contracts; a byte-identical copy of the server's mapping, which a test checks), `diagnostics.ts` (upstream failures as this browser's `provider` events: provider, host, status and reason code, never the URL). |
| `lib/` | Browser ports of pure server code: `safeJson`, `mergePatch`, `ids`, `base64`, `imageSniff`, `imageSize`, `cache`, `fetch` (timeouts, size caps, provider errors), `validate`, `cleanTitle`, `htmlScan` (tag scanning, `htmlToPlainText`), `importHtml`, `importPlan`, `siteName`; for the calendar: `calendarTime`, `calendarText`, `windowsZones` (+ `windowsZones.json`, the server's CLDR table), `calendarRecords` (stored row shapes, `sanitizeEvent`, async SHA-1 `eventId`, `toCalendar` / `toCalendarEvent`), `calendarStore` (the server's store.ts over the calendar slices: calendar upserts, the per-calendar replace step of a sync, write-through upserts, the events query). The pure calendar ports are checked against the server by `server/src/modules/calendar/staticParity.test.ts`: change both sides together. |
| `lib/__fixtures__/`, `providers/__fixtures__/` | Test data: images and Netscape bookmark files; Open-Meteo, Nominatim, Todoist Microsoft Graph (`graph.ts`) responses, an in-memory GitHub repository for the GitHub store (`github.ts`) and `createFakeFetch()` (`fakeFetch.ts`) for provider and handler tests. |
| `test/harness.ts` | `createTestBackend([modules])` → `{ctx, call, json, fetch, tick, objectUrls, storage}` with deterministic ids/clock; `fileForm()`, `PNG_BYTES`, `GIF_BYTES`. |
| `test/setup.ts` | Vitest setup for the `static` project: `fake-indexeddb/auto`, zod jitless. |

## Writing a handler module

```ts
import type { StaticContext } from '../context.ts';
import { json, noContent, notFound, readJson, StaticApiError, validationError } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getThings, SLICE } from '../slices.ts';

export function register(router: StaticRouter): void {
  router.get('/api/things', (ctx) => json(getThings(ctx)));
  router.post('/api/things', async (ctx, { req }) => {
    const parsed = ThingCreateSchema.safeParse(await readJson(req));
    if (!parsed.success) return validationError(parsed.error);
    const things = getThings(ctx);
    const thing = { id: ctx.newId(), createdAt: ctx.now(), ...parsed.data };
    things.push(thing);
    await ctx.state.commit(SLICE.things);
    return json(thing, 201);
  });
  router.delete('/api/things/:id', async (ctx, { params }) => {
    const things = getThings(ctx);
    const index = things.findIndex((t) => t.id === params.id);
    if (index === -1) return notFound('Thing not found');
    things.splice(index, 1);
    await ctx.state.commit(SLICE.things);
    return noContent();
  });
}

export async function ready(ctx: StaticContext): Promise<void> {
  // First-run seeding, registering stored images as object URLs, pruning orphans.
}
```

Then add the module to `MODULES` in `handlers/index.ts`. Rules of the house:

- **Mirror the server.** Same status codes, error codes and messages, ordering, limits and the
  shared zod schemas from `@portly/shared`, so export files round-trip and the unchanged UI
  behaves identically. Port pure server code by copying it into `lib/`; never import from
  `server/src` (it pulls in hono and node modules) and never edit `shared/src` (frozen contract).
- **Browser-only code.** No `node:` imports, `Buffer` or `process`. `TextEncoder`/`TextDecoder`,
  `atob`/`btoa`, `ctx.newId()` for ids, `lib/fetch.ts` for outbound calls (timeouts, caps, and
  provider failures turned into `502 provider_error` / `504 upstream_timeout` / `429 rate_limited`
  responses — a thrown `TypeError` would make the client show "Portly is not reachable").
- **Responses.** JSON through `json()` (always `content-type: application/json`), deletes answer
  `204` through `noContent()`, errors through `apiError`/`StaticApiError`. Only the Outlook.com
  modules (`accounts.ts`, `calendar.ts` and its Graph client) set `accountId` on an error or emit
  `reauth_required`, as the server does for an account (ErrorState then offers Reconnect); no other
  handler does, and none emits `network_error` (client-side only). `/api/health` and `/api/about`
  always report `vault: 'ready'`.
- **Readiness.** `GET /api/profiles` and friends must only answer after the persisted state is
  loaded (`createStaticBackend` awaits `state.loadAll()` and every module's `ready()` before
  the first dispatch); an early empty answer makes the first-run seed create a duplicate profile.
- **TypeScript.** Strict, `verbatimModuleSyntax` (`import type`), `erasableSyntaxOnly`,
  `noUncheckedIndexedAccess`, explicit `.ts` import extensions, 2-space, single quotes, trailing
  commas, a file-header JSDoc explaining the module.

## Tests

Handler tests live next to the code as `web/src/static/**/*.test.ts` and run in the vitest project
`static` (Node environment, `fake-indexeddb` preloaded, zod jitless):

```powershell
node node_modules/vitest/vitest.mjs run --project static web/src/static/handlers/<module>.test.ts
npm run typecheck
```

Use `createTestBackend([yourModule])` with only your module registered and assert on
`status`, `body` (parse with the shared schemas and `ApiErrorBodySchema`) and `ctx.state`.
`backend.call(method, path, body)` sets the headers the API client sets; `fileForm()` builds a
multipart body like an upload.

UI tests that should run against the real backend instead of fetch mocks use
`web/src/test/renderWithStaticBackend.tsx` (vitest project `web`, jsdom): it creates a
`MemoryStorage`-backed backend with the modules `handlers/index.ts` lists, stubs global `fetch`
to `backend.fetch()`, and renders with the usual providers; seed state through the `seed`
callback (`ctx.state.set(...)` + `commit`) or a pre-filled storage.

## Build and publish

`web/vite.config.ts`: mode `static` sets `base` from `PORTLY_STATIC_BASE`, defines
`__PORTLY_STATIC__` and `__PORTLY_LOCAL_SERVER__` (hybrid mode's server origin from
`PORTLY_STATIC_SERVER`: default `http://127.0.0.1:5757`, `off` → `''`, loopback origins only —
`localServer/origin.ts`; the server build always defines `''`), writes to `web/dist-static` and
injects the Content-Security-Policy `<meta>` (`staticCsp(localServer)`; static hosts send no
headers; `connect-src` gains the local server origin). `web/public/.nojekyll` ships in the output so GitHub
Pages never runs Jekyll. Publishing: `scripts/publish-static.ps1` (manual, to a local clone of
the public repository) or `.github/workflows/static-pages.yml` (manual dispatch, deploy key).
