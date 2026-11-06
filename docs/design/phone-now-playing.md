# Design: showing what the phone is playing

**Status:** proposed on 2026-11-06, ROADMAP M.5. Phase 0 passed on the owner's phone on 2026-11-06
(section 10), with a throwaway app outside this repository. Phase 1, the server side, is built, and
ARCHITECTURE sections 4, 5, 7 and 20 are the binding text for it. Nothing shows in the widget yet, and
phase 2 waits for the owner's go.

**Main idea:** a small Android helper app reads what Pocket Casts is playing and tells Portly
through the same Tailscale address other PCs use. The helper signs in as a new, limited kind of
device that can report what is playing and do nothing else. The Music widget then shows the
episode. Portly never touches a Pocket Casts account, and the server stays on loopback.

## 1. Why a helper app

Pocket Casts has no public API for a user's account. Its one official integration, a public MCP
server, only searches the catalog. The alternative is an unofficial API, which needs the user's
Pocket Casts password, runs a minute or two behind, can't pause or skip, and may conflict with
sections 1.4(iii) and (iv) of its terms. That API also refuses other sites, so it would be
server-only as well.

The phone already knows everything. Android apps publish what they are playing to the system, for
the lock screen and for Bluetooth and car controls. Another app may read that with the user's
permission.

## 2. What is known, and how well

| Fact | Evidence | Seen on a real phone? |
| --- | --- | --- |
| Pocket Casts publishes the episode title, the show, the author, the duration, the position, the speed, the state, an episode id and the art | `MediaSessionManager.kt` in its open-source Android app | Yes, all of them. It also keeps a second, thinner session (section 7) |
| It accepts play, pause, seek, fast-forward and rewind from the system | The same file | It lists all five. Pause and play from the system's media keys worked. Commands from another app, which phase 4 needs, were not tried |
| Reading another app's playback needs notification access, granted by hand in Android settings | Android's `MediaSessionManager`, developer reports | Yes |
| Android 13 and later hold that access back from apps installed outside a store, until the user picks **Allow restricted settings** in the app's info page; Android 15 widened this | Press reports | Not after an `adb` install on Android 17: the block was never applied |
| Developer verification started on 2026-09-30 in four countries and is planned worldwide from 2027. `adb` installs stay exempt | Google's developer blog, press reports | An `adb` install worked, with an app signed by a throwaway key |
| A native client with no `Origin` and no `Sec-Fetch-Site` passes the gate's remote branch, given `X-Portly: 1`, JSON and a device cookie | `server/src/security/gate.ts`, read | Half of it. With no cookie the phone gets 401 `login_required`, and with no header 403. A request that passes needs a device cookie (phase 3) |
| Tailscale Serve reaches the remote port | Real check with a second PC (multi-pc.md, B.5) | Yes, on home Wi-Fi: `/api/health` answered 200 with `remote: true` and a valid certificate. Mobile data was not tried |
| Pocket Casts' package id is `au.com.shiftyjelly.pocketcasts` | The source's namespace; its build sets the real id from a property | Yes |

## 3. How it fits together

```
Pocket Casts on the phone
   | Android's media session (on the phone only)
Portly helper app
   | HTTPS through Tailscale, on each change and every 30 s while playing
Tailscale Serve on the main PC  -->  remote port 5758  -->  Portly server (held in memory)
                                                               |
Music widget, on any PC  <-- GET /api/music/phone every 5 to 15 s --'
```

Spotify keeps working as it does today. Neither service knows about the other: the widget reads
both and picks one (section 6).

## 4. The way in: a limited device

Today a connected device is fully trusted (ARCHITECTURE 4.1). A phone holds a long-lived secret and
gets lost, so the helper must not get that trust.

- **Scope.** Migration 008 adds `scope` to `devices` and `device_requests`: `full` (the default, so
  every existing PC stays as it is) or `reporter`.
- **Fails closed.** Two route tags mark the only routes a reporter may call: `reporter()` the report
  itself, and `anyDevice()` disconnecting itself, which every other device uses too. `deviceMayCall`
  takes the scope, and a scope that isn't `full` gets the narrow answer. A reporter is refused
  everywhere else with 403 `local_only`, including every `paired()` route and the `enrollment()`
  routes, and full devices may not call `reporter()` routes. `pagesDeviceMayCall` refuses reporters
  outright. The test that pins every route's access gains these cases, and a new one sends a
  reporter through the real gate to every route.
- **Connecting.** The existing flow: the helper calls `POST /api/devices/requests {label, scope}`,
  shows the code, and the owner approves it in Settings → Devices. Nothing new to remember, no
  password. The approval card says plainly that this device can only report what is playing.
- **The secret.** The same device cookie value, sent by the helper as a plain `Cookie` header. Only
  its hash is stored, it can be revoked in Settings → Devices, and the 30-day idle rule applies. A
  month with no listening means approving the phone again. A device being removed, in any way, hides
  its latest report at once, and the next read or report drops it from memory.
- **Asking again.** A phone that lost its way leaves its old cookie out when it asks: a reporter's
  cookie is refused on `enrollment()` routes like everywhere else.

## 5. The report

`POST /api/music/phone` (`reporter()`), latest wins:

```
{ app, state: 'playing' | 'paused', title, show, durationMs, positionMs, speed, episodeId? }
{ app, state: 'stopped' }
```

`GET /api/music/phone` (`paired()`) answers `PhonePlayback | null`.

- **Hostile text.** Titles come from podcast feeds, so treat them like mail subjects: strict zod
  schema, plain text only, rendered by React. The title and the show are cleaned to one line and cut
  to 500 characters rather than refused, because a stray character in someone's feed should not lose
  the owner a whole report. `app` is a closed list, and anything the schema doesn't name is a 422.
- **No address from the phone.** A link is never taken from the report. If a link is added, the
  server builds it from a validated episode id for a known app (phase 2 checks the address format).
- **Memory only.** It is listening history, so it stays in server memory, never in SQLite, the
  persisted browser cache or a log (section 17). Logs carry the device id only.
- **Going stale.** A `playing` report with no follow-up for 90 s counts as gone: the phone has left
  the network or switched off. A `paused` report is kept for 15 minutes (decision 4). `stopped`
  clears it. A restart of the server clears it too.
- **Position.** The server moves a playing position on by its age times the speed, as it does for
  Spotify, and each report corrects it.
- **Limits.** One report per second per device, then 429.

## 6. In the widget

- **Which one shows.** Whatever is playing. If both are, the one that started last. If neither,
  a paused item, then the normal idle state (decision 3).
- **Controls.** View-only at first. Play, previous and next are hidden, not disabled, through a
  new `MusicFeatures.control` flag, because the buttons can't do anything. The position bar is read-only.
- **Credit.** A phone icon and the words "Pocket Casts, on your phone". Spotify's logo and layout
  rules stay on Spotify content only.
- **No Spotify account.** A report still shows, instead of the "connect a music service" card.
- **Browser-only site.** It answers `null` when no server is behind it, so nothing changes there.
- **Diagnostics.** A health subject `phone:<deviceId>` says when the last report came, with no titles.

## 7. The Android app

Small on purpose: one settings screen and one background listener, written in plain Java with no
libraries, so the installed app holds only our code.

- **Permissions.** `INTERNET` and notification access. That access is broad: it could read every
  notification. The helper uses it only to reach media sessions and never implements the callback
  that receives notifications. Anyone can check that in the source, and the setup guide says so.
- **Only named apps.** Reports come from an allow-list holding just Pocket Casts (decision 2).
  Spotify stays out, since Portly reads it directly. Android shows the helper every app's session, so
  this list is what keeps the rest private.
- **Which session.** Pocket Casts keeps two sessions at once. Both give the title, state, position and
  length, and only one gives the show, author, episode id and art. The helper reads the one with an
  episode id, because the order of the two is not promised.
- **Sending.** On a change of episode or state, and every 30 s while playing. One pause or play fires
  three to five callbacks on the phone, so the helper waits for a short quiet moment and sends one
  report, which also keeps it under the server's limit of one report a second. Only the newest state
  matters, so there is no queue: a failed send waits for the next change, backing off to 5 minutes.
- **Refused.** On 401 it stops sending and shows one notification asking to reconnect.
- **Address.** Accepts `https://*.ts.net` only, the same rule as the site's connect page.
- **Storage.** App-private storage, with `allowBackup="false"` so the secret never reaches a cloud backup.

## 8. Building and installing

- **Where.** A new top-level `android/` folder (decision 5). The Gradle wrapper is pinned with its
  checksum. The Android Gradle Plugin and a test library are build-only dependencies, but adding them
  to the repository still needs the owner's OK (CLAUDE.md), asked for at phase 3. Phase 0 stays in a
  scratch folder.
- **Tools.** Java 21 and the Android command-line tools, about 760 MB with one platform (decision 1).
  Phase 0 kept them in `%LOCALAPPDATA%\Android`, with nothing on PATH or in the registry.
- **Installing.** `adb install` from the PC, over USB or wireless debugging, because that route
  stays open under developer verification.
- **Signing.** One personal signing key, kept outside the repository and backed up. Android only
  accepts updates signed with the same key, so losing it means reinstalling and reconnecting.
- **Publishing.** The APK stays out of public releases, at least until it has been used for a while
  (decision 6).

## 9. What does not change

- The server listens on loopback only. The phone arrives through the same HTTPS address as other PCs.
- No Funnel. If Tailscale is off on the phone, the helper is simply quiet.
- No Pocket Casts password, token or API call anywhere.
- Secrets stay write-only, and approval stays on the main PC.
- Every existing device keeps its scope and every existing route keeps its access.

## 10. Phases

Each phase ends with a report, and the next waits for the owner's go.

0. **Prove it on the phone** (S). Nothing in Portly changes.
   - Install Tailscale on the phone, then open `https://<pc>.<tailnet>.ts.net/api/health` in its browser.
   - Set up the tools, and build a throwaway app in a scratch folder that shows on screen what it
     reads and sends nothing.
   - Install it, grant notification access, and play an episode.
   - *Done when:* the phone shows the right episode, show, position and state. Note the real package
     id and any Android warnings. If Android won't grant the access, stop here and rethink.
   - **Passed on 2026-11-06** on a Samsung phone with Android 17 (API 37) and One UI 9, using a test
     app with no internet permission. It showed the right episode, show, author, length, state,
     speed, episode id and art, and the position moved on as it played. It caught pause and play with
     the app in the background. The package id is the one above, and access needed no extra step.
1. **Server** (M). Migration, device scope, `reporter()`, both routes, the in-memory store, tests
   for every refusal in section 4. *Done when:* a fake reporter's report is readable and it is
   refused everywhere else; a full device is unaffected.
   - **Built on 2026-11-06.** `GET` answers without the episode id, which nothing uses until a link
     exists, and with `startedAt`, for decision 3. A helper app really reporting is phase 3.
2. **Widget and settings** (M). Section 6, the approval card, the reporter label in Settings →
   Devices, the browser-only answer, diagnostics, §10.7's definition of done.
3. **The real helper** (M). Section 7, the signing key, an `android` CI job with pinned actions, a
   plain-English `docs/setup/phone-helper.md`, the privacy page. *Done when:* an episode on the phone
   shows in the widget on both PCs, and removing the device stops it.
4. **Later, each its own decision.** Pause and skip (the phone asks Portly for waiting commands while
   something plays), cover art (a small image in the report), other audio apps.

## 11. Decisions for the owner

| # | Decision | Recommended | Why |
| --- | --- | --- | --- |
| 1 | Build tools | Android command-line tools and a JDK on one PC | Much smaller than Android Studio, and we only need to build |
| 2 | Which apps report | Pocket Casts only | Reports nothing else you listen to; adding apps later is one list |
| 3 | Both playing | The one that started last | Follows what you just did |
| 4 | How long a pause shows | 15 minutes | Long enough to stay useful, short enough not to go stale |
| 5 | Where the code lives | `android/` in this repository | One line of work; the contract and the helper change together |
| 6 | Publish the APK | Not yet | The source is public anyway; a public APK adds signing and verification duties that one user doesn't need |

## 12. Not known yet

- Whether Android keeps a quiet listener alive over a day on battery. It survived minutes with the phone
  plugged in. Some makers stop background apps, and Samsung's Auto Blocker may matter: its effect on an
  installed helper was not checked.
- Whether the helper can send while the screen is off and the phone is idle. The test app has no
  internet permission, so phase 0 could not show this. If it can't, the helper may need a battery
  exemption, and the setup guide must say so.
- Whether Tailscale stays connected on the phone all day and on mobile data, and what that costs in
  battery.
- Whether a command from another app reaches Pocket Casts' session (phase 4 only).
- The address format of a Pocket Casts episode link, if one is added.
- How the Pages site on the home PC reaches `GET /api/music/phone` in hybrid mode. It should behave
  like the other `paired()` music routes, and phase 2 checks that.
