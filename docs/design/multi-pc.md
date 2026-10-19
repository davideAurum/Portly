# Design: using Portly from several PCs, with a login

**Status:** proposal, not built. This is the ROADMAP Phase 3 item "one server reachable from
several PCs, with a login". Until it ships, the server stays on loopback only (ARCHITECTURE
section 4).

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

## Open questions

- **Is approve-from-the-main-PC enough as the only login?** It's the simplest and can't be
  brute-forced, but a stolen laptop with a live cookie has access until the device is revoked.
- **Tailscale only, or any HTTPS proxy?** Supporting only Tailscale lets Portly add the
  identity-header check. Supporting any proxy is more flexible but relies only on the device
  cookie.
