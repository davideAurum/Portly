# Design: using Portly from several PCs, with a login

**Status:** being built as [Track B of the ROADMAP](../ROADMAP.md#track-b-multi-pc), beside the
phases, on the owner's go of 2026-10-21 (decision D10 asked for one). Phase 1 (the server) is
built; phases 2 and 3 follow; the "later" items stay later. The server stays on loopback only
(ARCHITECTURE section 4) throughout: with no `PORTLY_REMOTE_ORIGIN` it behaves exactly as before.

**Main idea:** the server still listens only on `127.0.0.1` and `::1`. Other PCs reach it through
an HTTPS reverse proxy running on the main PC, such as Tailscale Serve. Each PC must be approved
once, from the main PC, before it can use Portly. Nothing in this design needs a new dependency.

## 1. How other PCs reach the server

```
Other PC (browser) --HTTPS--> Tailscale Serve on the main PC --HTTP--> 127.0.0.1:5757 (Portly)
                              https://<pc>.<tailnet>.ts.net
```

- Add a new setting, `PORTLY_REMOTE_ORIGIN=https://<pc>.<tailnet>.ts.net`. It must be https,
  because the login cookie needs `Secure`.
- The documented setup is Tailscale **Serve**: reachable only inside your tailnet, with a real
  certificate and no changes to the Windows firewall. The docs say clearly not to use **Funnel**,
  which puts it on the public internet. Any HTTPS reverse proxy on the main PC would also work.
- Portly never opens a LAN socket. The rule in section 4 becomes: the listener is loopback only,
  and other PCs arrive only through the configured HTTPS origin.

## 2. Telling local requests from remote ones

Every request arrives from `127.0.0.1` because of the proxy, so the client's IP address can't tell
them apart. The **Host header** decides instead, and the request gate classifies each request
once, at step 2:

| Host header | Class | Needs |
| --- | --- | --- |
| `localhost` / `127.0.0.1` / `[::1]` with Portly's port | `local` | Nothing new (same as today) |
| The host of `PORTLY_REMOTE_ORIGIN` | `remote` | A valid device cookie, except on the enrollment and health routes |
| Anything else | - | 403, as today |

- A web page can't fake the Host header, and DNS rebinding produces a different host, which is
  still rejected. Local processes could fake it, but they are already trusted under section 4.1.
- `X-Forwarded-For` and similar proxy headers are ignored.
- Optional extra check: require Tailscale's `Tailscale-User-Login` header to equal a configured
  login. That would also block Funnel traffic. Before relying on it, confirm that Tailscale strips
  that header from incoming requests.

## 3. Login: approve each PC from the main PC

There are no passwords to store, guess or reset. This works like browser pairing (section 16), and
approving a PC is a local-only action.

1. **Request.** The other PC opens the remote URL and gets `401 login_required`. It shows a
   "Connect this device" screen. `POST /api/devices/requests {label}` creates a pending request
   (expires in 10 minutes, at most 3 pending, rate-limited). The other PC gets a short display
   code like `K7Q-4MP` and an `__Host-portly_enroll` cookie.
2. **Approve.** On the main PC, Settings > Devices lists the pending request with its label, code
   and browser/OS summary. You check that the code matches and approve it with
   `POST /api/devices/requests/:id/approve` (local-only, so it returns 403 `local_only` from
   another PC). The code is only for comparing by eye. It isn't a secret.
3. **Session.** The other PC is polling `GET /api/devices/requests/current`. Once approved, the
   server swaps the enroll cookie for a device cookie:
   `__Host-portly_device=<32 random bytes>`, with `HttpOnly; Secure; SameSite=Strict; Path=/`.
   - Only a SHA-256 hash is stored, as with pairing tokens.
   - The session renews while in use and expires after 30 days unused.
   - The device can be revoked at any time from Settings > Devices.

Why a cookie and not a token header like pairing: here the page and the API share an origin. An
`HttpOnly` cookie can't be stolen by injected script. Cross-site request forgery is still blocked
by `SameSite=Strict`, the existing `X-Portly: 1` requirement (the server never answers CORS
preflights) and the `Sec-Fetch-Site: same-origin` check.

## 4. What a remote PC can do

- Reuse the existing `paired()` route tag, perhaps renamed `trusted()`. Its rules already fail
  closed, and a test already pins every route's access.
- These stay **local-only**:
  - approving devices and pairings;
  - the vault reset;
  - full diagnostics, including the data folder and log path;
  - `browserBookmarkImport`, which would otherwise read the main PC's browser files.
- **OAuth sign-in stays on the main PC in v1.** The redirect URIs point at loopback
  (`127.0.0.1:5757`), which on another PC would mean that PC itself. Accounts connected on the
  main PC still work from every device, because the tokens live on the server. A remote PC shows
  "Connect accounts on the main PC."
- Add a new capability flag, `remoteClient`, to hide local-only actions. `pagesForward` must not
  forward remote clients to the Pages site, because that site only looks for a server on loopback.

## 5. Data and contracts

```sql
devices(id TEXT PRIMARY KEY, label TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
        user_agent_summary TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)
device_requests(id TEXT PRIMARY KEY, code TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')))
```

- Schemas go in `shared/src/devices.ts`. The server code goes in a new module,
  `server/src/modules/devices`, next to `pairing`.
- Logs record the device id only, never the label, code or cookie (section 17).

## 6. Phases

1. **Server:** the remote origin setting, the Host-based classification, the devices module, the
   cookie session and route access. Tests use `testRequest()` with remote Host headers and cover:
   - no cookie;
   - a revoked device;
   - cross-site request forgery attempts;
   - local-only routes called with the remote Host.
2. **Web:** the connect screen, Settings > Devices, the `remoteClient` flag, and the forwarding
   change.
3. **Docs and scripts:**
   - a new ARCHITECTURE section and an update to section 4.1 (each approved device is fully
     trusted, like a paired browser);
   - `docs/setup/other-pcs.md`, covering Tailscale Serve setup and why not to use Funnel;
   - a `-RemoteOrigin` option in setup, with `-DryRun`.
4. **Later:**
   - extension support (a configurable server address with optional host permissions), so the
     other PC's New Tab opens the main PC's Portly;
   - OAuth sign-in from other PCs (https redirect URIs for the remote origin);
   - a passkey as a second factor, in case a laptop is stolen.

## Decisions of 2026-10-21 (the open questions, answered)

- **Approve-from-the-main-PC is the only login**, with revoke in Settings > Devices and a 30-day
  idle expiry. It cannot be brute-forced and works like pairing. A stolen laptop with a live
  cookie has access until the device is revoked from the main PC; the passkey second factor stays
  a "later" item.
- **Any HTTPS reverse proxy**, with Tailscale Serve as the documented setup and a plain "never
  Funnel". The device cookie is the login. The `Tailscale-User-Login` header check stays "later":
  nobody has verified that Tailscale strips a forged copy of that header, so a check built on it
  would be false safety until the four-way probe (forged versus stripped header, this PC versus a
  second device) has run for real.
- **The proxy must keep the Host header.** The classification in section 2 relies on it: a proxy
  that rewrote the Host to a loopback one would make every other PC look like this PC, with no
  login at all. The server can only catch the half-way case: with a remote origin configured, a
  request with a local Host that carries a forwarding header (`Forwarded`, `X-Forwarded-*`,
  `Tailscale-User-*`) is refused (403 `proxied_local_host`) and logged. A proxy that rewrites the
  Host and adds no such header is invisible to it, so the setup guide (B.3) makes one check
  mandatory before approving anything: from the other PC, `GET /api/about` through the proxy
  with `X-Portly: 1` and no cookie must answer 401 `login_required`; a 200 means the proxy rewrote
  the Host. The connect screen (B.2) does the same check on load and refuses to go on when the
  server answers it as local. The real check with a second device records which headers Tailscale
  Serve sends.
- **What phase 1 built, where it differs from the text above:**
  - the device is made when the other PC polls after approval (`GET /api/devices/requests/current`
    with the enrollment cookie), so no secret is ever stored in clear: approval only flips the
    request's status, and the poll mints the device cookie and clears the enrollment cookie. The
    request row stays, marked claimed, until it expires: while the device has never been used,
    the same poll mints a fresh cookie for the same device, so a lost answer strands nobody. The
    enrollment cookie outlives the request by an hour, so the last poll can still say expired;
  - a route tag `samePc()` beside `paired()`: the paired Pages site (on this PC) may call it,
    another PC may not. It marks the vault reset, the browser bookmark import (`sources` and
    `browser`), the OAuth start and the diagnostics report (it carries this PC's paths and log
    files); approving devices and pairings stays untagged (local-only). Overlapping registrations
    let in only the callers every one of them names, so a tag never widens another route.
    A tag `enrollment()` marks the two routes another PC may call without a device cookie;
  - the remote branch of the gate applies the same request-header rules as a local request
    (`X-Portly: 1`, `Sec-Fetch-Site` absent or `same-origin`, an absent or exactly-remote
    `Origin`, the Content-Type rules) before it looks at the cookie, and never sends CORS headers;
  - a loopback remote origin on another port (`https://localhost:8443`) is accepted with a
    start-up warning, so the connect flow can be tried on this PC through a local HTTPS proxy
    before any second PC exists;
  - revoked and expired devices keep their row for 30 days, so their cookie is refused as
    "revoked" (with the reason) rather than "unknown", like pairing tombstones; the 30-day idle
    rule is applied on every listing and write, not only when a device presents its own cookie;
  - the device cookie's lifetime is renewed on use (at most every 10 minutes), except on an answer
    that set or cleared the cookie itself (disconnecting, the enrollment swap);
  - logs carry request and device ids only; the diagnostics log filters gained `deviceId`.
