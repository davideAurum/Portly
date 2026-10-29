# Browser-only build (GitHub Pages)

The browser-only build is the same Portly dashboard built as plain files — HTML, JavaScript,
CSS — that run entirely in your browser. There is no Node.js server, nothing to install and nothing
to keep running: you open a URL, and everything you set up is kept in that browser's own storage.
It is made for hosting on GitHub Pages (any static web host works the same way).

It is not a replacement for the full Portly. The server build keeps your credentials in an
encrypted vault, syncs calendars in the background, reads mail and fetches pages on your behalf;
the browser can do only some of that on its own (your Outlook.com calendar, while the page is
open), so the rest is simply not there — unless Portly also runs on the PC you are using: a
browser you have paired with it uses Portly's own data and features while it runs
([hybrid mode](#hybrid-mode-portly-on-this-pc)).

## What works, what doesn't

| Works | Not available |
| --- | --- |
| **Search** — engines and keywords, URL detection, bookmark matches, suggestions from Wikipedia (the one suggestion provider that allows requests from a browser). An engine whose own suggestions need Portly (Google, DuckDuckGo, Bing, YouTube) shows none, unless you turn on **Settings → Search → Wikipedia suggestions instead** (off by default, a setting of this browser): it then shows Wikipedia's, under the heading *Wikipedia suggestions* | Suggestions from Google, DuckDuckGo, Bing or YouTube |
| **Launch pad** — bookmark groups, drag-and-drop ordering, import from an HTML bookmarks file, custom icons; site icons come from DuckDuckGo's icon service; optional **launch pad sync** between browsers through your OneDrive or a private GitHub repository (see below) | Import straight from the Chrome/Edge profile files; fetching a page's title and icon |
| **Clock**, **Weather** (Open-Meteo, no key) | — |
| **Sports scores** — scores, results and schedules straight from ESPN's public feeds | — |
| **Todoist** — tasks, quick add, complete with undo (token stored in the browser, see below) | — |
| **Calendar** — your **Outlook.com** calendars, read and written straight from the browser through Microsoft Graph (an app registration you own, see [Outlook.com](microsoft.md#browser-only-build-github-pages)); they sync while the page is open | Google, Yahoo and CalDAV calendars, ICS / webcal subscriptions |
| **Themes**, background image upload, **profiles**, **export / import** | — |
| — | **Mail** and **RSS feeds** widgets, Google, Yahoo, CalDAV and IMAP accounts, the credential vault |

The parts that are not available are gone from **Add widget** and from Settings. If you import an
export made on the server build and its layout still has a mail widget, that widget shows *Mail
needs the Portly server* with *Not available in the browser-only build*; remove it in edit mode.
In a site built with hybrid mode (the default) the notice reads *Mail needs Portly running on this
PC* instead, with a button that looks for it (or pairs this browser with it). The calendar widget is
not in the first-run layout (it needs the Outlook.com setup first): add it from **Add widget**. That
layout fills the page without gaps: the search box and clock on top, the launch pad with Todoist
below it, and the weather, with its 7-day forecast, down the right-hand side.

## Browsers

The alpha supports Chromium browsers: **Chrome** and **Edge**. Firefox is checked by hand at most
(a smoke run: the page loads and its widgets work), never with the full test pass, and even that
run is still to come, so it is not supported yet. Safari is not supported: it deletes a site's
script-written storage after seven days without a visit (see
[Where your data lives](#where-your-data-lives)), which would take your settings and bookmarks
with it. The server build's new-tab extension is for Chrome and Edge as well
([README](../../README.md#requirements)).

## Where your data lives

- **In this browser, on this device.** Settings, layouts, bookmarks, uploaded images, the
  Todoist token, the Outlook.com sign-in and a copy of your Outlook.com calendars (30 days back, a
  year ahead) are stored in the browser's IndexedDB for the site's address. Nothing is sent to
  GitHub or to any Portly server (there is none). Another browser, another device, another
  browser profile — or the same site at a different address — starts empty.
- **A quick-start copy, too.** So the page can show itself at once, it also keeps a snapshot of
  what it last showed, including the calendar events on screen (titles, places, notes), in the
  browser's local storage for the site. The snapshot is dropped after 24 hours or when Portly is
  updated; clearing the site data removes it right away.
- **Move it with export / import.** **Settings → Import & export** writes a `.json` file with your
  settings, layouts, bookmarks, background image and custom icons; import it on the other
  computer. The file never contains the Todoist token or the Outlook.com sign-in — set them up
  again there.
- **The Todoist token and the Outlook.com sign-in are not encrypted.** The server build keeps
  them in a vault protected by Windows; here they sit in the browser's site storage, readable by
  anyone who can use this browser profile (and by browser extensions with site-data access). On a
  shared PC, remove them in **Settings → Accounts** (**Remove** on each row, Todoist included)
  when you are done, or don't connect them at all. A Microsoft sign-in from a web page lasts 24 hours; Portly renews
  it by itself when you open the page while you are still signed in to Microsoft, else the account
  shows *Reconnect*.
- **Calendars sync while the page is open.** There is no background job: a calendar on screen
  checks Outlook.com every sync interval (**Settings → Calendars**, 5 minutes by default) and
  right away when you open the page after a while. Several tabs share one sync.
- **Safari forgets.** Safari deletes a site's script-written storage after seven days without a
  visit (interaction), unless the site is added to the Dock / Home Screen. Export before a long
  break, or keep using it.
- **Private windows keep nothing.** In a private / incognito window the data lasts until the
  window closes; where the browser refuses storage altogether Portly shows *Nothing can be
  saved in this browser* and runs from memory. Clearing the browser's site data removes everything
  too.
- Several tabs of the site stay in step with each other.
- **Launch pad sync (optional).** It keeps the launch pad (groups, bookmark titles and addresses,
  their order, custom icons, and which group is the default) the same in every browser where you
  turn it on, through **one** sync connection per browser: a Microsoft connection with **Launch
  pad sync** ticked, or GitHub. Layouts, widgets, the theme and the other settings stay per
  browser. It runs while a Portly page is open (at page load, on focus, every 5 minutes, a few
  seconds after a change); the connection's card in **Settings → Accounts** shows its status,
  **Sync now** and **Details**, and **Settings → Bookmarks** says whether the launch pad syncs.
  The first time a browser that already has a launch pad meets a synced one that differs, Portly
  asks which to keep. A sync that would replace or remove much of the launch pad keeps a backup
  first (**Settings → Import & export**, *Backup before sync*), and an import replaces the launch
  pad in every synced browser (the preview says so).
- **Launch pad sync through OneDrive.** The files are kept in your OneDrive under **Apps**, in the
  folder named after your Microsoft app registration, which Microsoft can read. Portly doesn't
  encrypt them, and the permission reaches only that folder
  ([Outlook.com](microsoft.md#browser-only-build-github-pages)).
- **Launch pad sync through GitHub.** **Settings → Accounts → GitHub** keeps
  the name of a *private* repository you create on GitHub and a fine-grained token limited to it
  (Contents: Read and write). Once they are saved, your groups, bookmark titles and addresses, and
  custom icons are stored in that repository. Only your account can read it (and GitHub). Every change is a commit, so the
  repository's history keeps old launch pads, removed bookmarks included, until you delete the
  repository. Portly doesn't encrypt the files. Like the Todoist token, the repository name and
  token are stored unencrypted in this browser and never exported. Portly refuses a public
  repository and classic tokens; **Remove** them in **Settings → Accounts** on a shared PC.
  Design: `docs/design/launchpad-sync-github.md`.

## Hybrid mode: Portly on this PC

When the Portly server also runs on the PC you browse from, the published site can use it: once
you have paired the browser with it (a one-time approval on Portly's own page), every page load
that finds Portly running uses Portly's data and everything the server adds — calendars, mail,
feeds, accounts, page titles and icons, all search suggestions. When Portly isn't running, the
site uses this browser's copy as described above, and the footer says **Browser only** (in a
browser that has not looked for Portly yet, **Not checked**, until you click it and choose **Look
for Portly on this PC**);
**Settings → Diagnostics** then shows this site and this browser, and offers **Open diagnostics on
this PC** only once Portly answers there. The two are separate sets of data; nothing is
copied between them. Setting it up (the server's `PORTLY_PAGES_URL`, pairing, the browser's
permission prompt, disconnecting) is described in
[Pages site with Portly on this PC](pages-local-server.md).

At build time, `PORTLY_STATIC_SERVER` says where the site looks for Portly:

| Value | Meaning |
| --- | --- |
| *(unset)* | `http://127.0.0.1:5757`, Portly's default address. |
| `http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>` | Portly on another port (the same as its `PORTLY_PORT`). `https://` and `*.localhost` hosts are accepted too; only an origin, no path. |
| `off` | No hybrid mode: the site never contacts anything on this PC (the browser-only build as before). |

Anything that is not on this PC (for example `http://example.com`) fails the build: the site sends
its pairing token there. The address is added to the site's Content-Security-Policy
(`connect-src`) and nothing else: Portly's images reach the page as `blob:` / `data:` URLs.

## Build it

```powershell
npm ci
npm run build:static         # writes web\dist-static
```

`npm run build:static` is `vite build --mode static`: it builds the same app with the server-only
parts switched off and an in-browser backend switched on, into `web\dist-static` (the server's
`web\dist` is untouched, so `npm start` keeps working; `web\dist-static` is ignored by git).

**Base path.** GitHub Pages serves a *project* site at `https://<user>.github.io/<repo>/`, so the
build must know that prefix. Set `PORTLY_STATIC_BASE` before building — it must start and end
with `/`:

```powershell
$env:PORTLY_STATIC_BASE = '/<repo>/'
npm run build:static
```

Leave it unset (`/`) for a *user* site (`https://<user>.github.io/`, repository named
`<user>.github.io`) or a custom domain. A wrong base shows a blank page: the browser looks for the
scripts in the wrong folder.

**Preview.** `npm run preview:static` serves `web\dist-static` at <http://localhost:5173> (port
`PORTLY_VITE_PORT`). Open it on **localhost only**: Portly creates ids with
`crypto.randomUUID`, which browsers provide only on secure pages — `https://…` and `localhost`
count, a LAN address such as `http://192.168.1.20:5173` does not and the app cannot save anything
there. Opening `index.html` straight from the folder does not work either (module scripts need a
web server). The preview stores its data under the `localhost:5173` address, separately from the
published site.

## Publish to GitHub Pages

**You need a second, public repository.** Every publish replaces the whole site, so it gets a
repository of its own (Pages sites are public to the whole internet anyway). It holds nothing but
the built files — no source code, and never your data, which stays in your browser.

**Create a NEW, EMPTY public repository just for this site** (`portly-pages` in the examples).
Publishing deletes every tracked file of the repository it is given — only `CNAME` and
`README.md` survive — so never point it at a repository that already serves other pages, such as
`portly-site` or your `<user>.github.io`. For a user site, `<user>.github.io` must be a
repository you do not use for anything else yet.

One-time setup:

1. Create the public repository on GitHub — empty: no README, `.gitignore` or license (a README
   alone does no harm) — and clone it next to your Portly folder.
2. In that repository: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main` (or `gh-pages` if you use the workflow below), folder `/ (root)`.
   **Enforce HTTPS** is on by default; leave it on.

### With the script

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-static.ps1 -PublicRepoPath ..\portly-pages -Base /portly-pages/
```

`scripts\publish-static.ps1` does, in order: fetches the clone's upstream and fast-forwards a clone
that is only behind it (a clone that has diverged is refused with the merge command to run);
`npm run build:static` with `PORTLY_STATIC_BASE` set to `-Base`; checks that
`web\dist-static\index.html` exists and uses that base; lists and removes every tracked file of the
public clone (`CNAME` and `README.md` are kept — they belong to the repository, not to the build —
and `.git` is never touched); copies `web\dist-static\*` plus an empty `.nojekyll` and a
`.gitattributes` (`*.ps1 -text`, `*.woff2 binary`, so `install.ps1` and `setup.ps1` are stored byte
for byte whatever the clone's line-ending setting) in and stages exactly those files; commits
(skipped when nothing changed); pushes. Run it with `-DryRun` first to see the list. Options:

| Option | Meaning |
| --- | --- |
| `-PublicRepoPath <folder>` | The local clone of the public repository (required; its checked-out branch is the one Pages deploys from). Everything tracked in it except `CNAME` and `README.md` is deleted. |
| `-Base </repo/>` | The site's URL path; default `/`. Same rule as `PORTLY_STATIC_BASE`. |
| `-Message "<text>"` | Commit message; default `Publish Portly <version> (<date>)`. |
| `-DryRun` | Fetch the upstream, print the plan — what would be fast-forwarded, built, removed, copied, committed, pushed — and change nothing else (no build either). It refuses exactly what a real run refuses. |
| `-NoPush` | Commit, but leave the push to you. |
| `-ReplaceEverything` | Publish even though the repository holds files that are not an earlier Portly publish (they are deleted). Only for a repository whose content you really mean to throw away. |

It refuses to run when the folder is not a git repository, when it is the Portly repository
itself (or any other Portly checkout), when its working tree has uncommitted changes or untracked
files, when no branch is checked out, or when the repository holds anything but an earlier
Portly publish, unless you pass `-ReplaceEverything`. An earlier publish holds only:

- `index.html` with `<meta name="portly-build" content="static">` (or `homebase-build`, from a
  publish made before the rename);
- `assets/`, `install.ps1` and `setup.ps1`;
- the files in `web\public` (today `favicon.svg` and `.nojekyll`), and `.gitattributes`;
- `CNAME` and `README.md`, which a publish never deletes.

When `origin` is on github.com and there is no `CNAME`, `-Base` must match the repository: `/` for
`<user>.github.io`, `/<repo>/` for any other (for a custom domain, set it up in the repository's
Pages settings first and pull, so its `CNAME` file is in the clone; `-Base` is then `/`). The
script prints the site URL when the remote is on github.com. GitHub Pages can serve the previous
page for up to 10 minutes after a publish (`Cache-Control: max-age=600`), so hard-refresh (Ctrl+F5)
before judging it.

**Published into the wrong repository?** The old files are still in that repository's history. In
its clone, undo the publish commit and push: `git revert HEAD` (or `git revert <publish commit>`),
then `git push`.

To update the site after pulling new Portly code, run the same command again.

### With GitHub Actions (optional)

`.github\workflows\static-pages.yml` does the same from GitHub's servers. It runs **only when you
start it** (Actions → *Publish static site* → **Run workflow**, with the inputs `public_repo`
= `<user>/portly-pages` and `base`); nothing is published on push. It builds with Node 24 and
pushes `web\dist-static` to the public repository's `gh-pages` branch with
[peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages) (set that
repository's Pages source to `gh-pages` / root). Like the script, it replaces that branch
completely on every run (`force_orphan`), so `public_repo` must be the new, empty repository made
for this site, never `portly-site`, `<user>.github.io` with its own pages, or Portly itself
(the workflow refuses its own repository).

The actions are pinned to full commit SHAs on purpose (`actions/checkout@<sha> # v5.1.0`): a tag
such as `@v4` can be moved to other code, and this workflow hands the deploy key to one of those
actions. To upgrade, resolve the new tag's commit — `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`;
if it answers `"type": "tag"`, follow it with `gh api repos/<owner>/<repo>/git/tags/<that sha>` —
and update both the SHA and the version comment; do not go back to `@vN`.

The workflow is disabled until it has a key: it stops at its first step with a clear message as
long as the `ACTIONS_DEPLOY_KEY` secret is missing. To set it up:

1. Generate a key pair without a passphrase (PowerShell or Git Bash):
   `ssh-keygen -t rsa -b 4096 -C "portly-pages deploy key" -f portly-pages-key`
   and press **Enter** twice when it asks for a passphrase, leaving it empty. (Don't pass it with
   `-N`: no spelling works in every shell — `-N '""'` sets the two characters `""` as the
   passphrase in Git Bash and PowerShell 7, and Windows PowerShell 5.1 drops the empty argument of
   `-N ""` — and the workflow cannot use a key with a passphrase.) Check:
   `ssh-keygen -y -f portly-pages-key` must print the public key without asking for a
   passphrase; if it asks, generate the key again.
2. Public repository → **Settings → Deploy keys → Add deploy key**: paste
   `portly-pages-key.pub` and tick **Allow write access**.
3. Portly repository → **Settings → Secrets and variables → Actions → New repository secret**:
   name `ACTIONS_DEPLOY_KEY`, value = the contents of `portly-pages-key` (the private key).
4. Delete both key files from your PC.

A deploy key is scoped to that one repository and does not expire; revoke it from the public
repository's **Deploy keys** page when you no longer need it.

## Good to know

**Caching.** GitHub Pages serves every file, `index.html` included, with a ten-minute cache. A tab
that loaded the old `index.html` right before a publish may ask for files that no longer exist;
Portly notices and reloads itself once. If you see an empty page within a minute of publishing,
wait a moment and reload.

**Security headers.** GitHub Pages sends no custom headers, so the Content-Security-Policy that the
server sends as a header is a `<meta>` tag in the static `index.html` instead: the same rules (no
inline or eval'd script, no frames or plugins) plus the third-party hosts the widgets now call
directly, and, with hybrid mode, the address of Portly on this PC. One directive cannot be expressed in a `<meta>` tag, `frame-ancestors`, so another site
could show the page inside a frame — the data stays in your browser either way, and the page
performs no privileged actions. Your browser's own protections (HTTPS, same-origin storage) are
what keep the data private.

**Who sees what.** Portly has no analytics and no server on the internet; the browser talks to:

| Service | When | What it receives |
| --- | --- | --- |
| GitHub Pages | Loading the app | Your IP address, like for any website |
| DuckDuckGo icon service (`icons.duckduckgo.com`) | Showing a bookmark whose icon is set to *Automatic* | The bookmark's **host name** (not the full URL). Hosts that look private — IP addresses, single-word names, `.local` — are never looked up. Pick a custom icon or the letter tile for a bookmark you want to keep to yourself. |
| Open-Meteo (`api.open-meteo.com`, `geocoding-api.open-meteo.com`) | Weather widget | The location you chose, and the text you type when searching for a place. Free for non-commercial use, no key; the data is [CC BY 4.0](https://open-meteo.com/en/license) and the widget shows the required attribution. |
| OpenStreetMap Nominatim (`nominatim.openstreetmap.org`) | Weather widget using this device's location | Those coordinates, rounded to about 1 km, to show the town's name instead of "Current location". At most once a week per spot; no key. The name is © OpenStreetMap contributors, credited in the widget. |
| Todoist (`api.todoist.com`) | Todoist widget | Your personal token with every request, straight from the browser — the same as the Todoist apps do. |
| Microsoft (`login.microsoftonline.com`, `graph.microsoft.com`) | Outlook.com account and the Calendar widget | The sign-in (your app registration's client id, the one-time code, then token refreshes), and the calendar requests with the account's access token: which calendars you have, the events of the synced window, and the events you create, change or delete. |
| Microsoft OneDrive (`graph.microsoft.com`, downloads from `my.microsoftpersonalcontent.com`) | Launch pad sync through a Microsoft connection, when it is ticked: a check at page load, on focus and every 5 minutes while the page is visible | The account's access token with each Graph request (downloads carry none); the launch pad file and custom icons, read on each check and written after changes. |
| GitHub (`api.github.com`) | Launch pad sync through your private repository, once it and a token are saved in **Settings → Accounts**: the check when you save them, then a sync check at page load, on focus and every 5 minutes while the page is visible | Your GitHub token and the repository name with every request; the launch pad file and custom icons, read on each check and written (as commits) after changes. |
| Wikipedia (`en.wikipedia.org`) | Search suggestions, while **Settings → Search → Search suggestions** is on (it is by default), for an engine with Wikipedia suggestions (the Wikipedia engine, keyword `w`). Only if you also turn on **Wikipedia suggestions instead** (off by default) in place of Google, DuckDuckGo, Bing and YouTube suggestions, which can't be asked from a browser. With the default engines and settings, nothing goes to Wikipedia unless you search with the Wikipedia engine. | What you have typed so far. |
| ESPN (`site.api.espn.com`, logos from `a.espncdn.com`) | Sports scores widget | Which leagues and teams you follow (as ESPN team ids). No key or account. With the Portly server (hybrid mode) the server reads the scores instead, but team logos still load from `a.espncdn.com`. |
| Portly on this PC (`http://127.0.0.1:5757`, hybrid mode) | In a paired browser, on every page load and then regularly while the page is open. In an unpaired one, on every page load and when the page gets focus, becomes visible or the network comes back (at most every 5 minutes while Portly isn't found) — once the browser has granted the site local network access, or right away when the browser has no such permission; otherwise only when you click **Look for Portly on this PC** | Nothing leaves the PC. Before pairing only a health check; once paired, every request of the page, with the pairing token. |

**The server build is unaffected.** `npm run build`, `npm start`, the extension and the autostart
scripts keep using `web\dist`; the two builds can even run at the same time on one PC (their
browser storage is kept apart).

## More

- [Setup overview](../SETUP.md) — the full, server-based Portly.
- [Pages site with Portly on this PC](pages-local-server.md) — hybrid mode: pairing, the
  permission prompt, disconnecting, and the shared-origin caveat.
- [Todoist](todoist.md) — getting the personal API token (ignore the part about the token being
  encrypted; see [Where your data lives](#where-your-data-lives)).
- `web\src\static\README.md` — how the in-browser backend is built, for developers.
