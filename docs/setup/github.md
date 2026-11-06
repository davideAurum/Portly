# Connect GitHub repositories

The **GitHub** widget is a status board of your own repositories, read with a **read-only token**.
There is no app registration and no sign-in page. It works on Portly's own page, on the Pages site
connected to Portly, on another PC, and on the browser-only site.

| What | How |
| --- | --- |
| CI result | The combined result of the latest commit on the default branch |
| Open work | Open pull requests and issues |
| Latest release | Its tag |
| Last push | How long ago |
| The **⋯** menu on each row | Open in GitHub Desktop, open the repository's pages, copy its clone address |

Portly changes nothing, on GitHub or on your disk: it runs no git commands. To fetch, pull or push,
use **Open in GitHub Desktop** and press the button there.

This is not **launch pad sync through GitHub** ([browser-only build](static-build.md#launch-pad-sync)).
That uses a different token, which reaches one private repository and may write to it.

## 1. Create a read-only token

1. Open GitHub's page for a new token, already filled in with the name, a 90-day expiry and the
   permissions:
   <https://github.com/settings/personal-access-tokens/new?name=Portly%20status%20board&description=Read-only%20status%20board%20for%20Portly&expires_in=90&contents=read&issues=read&pull_requests=read&statuses=read>
2. Under **Repository access**, choose **All repositories**. GitHub has no way to fill this in, so
   this step is yours.
3. Check that **Contents**, **Issues**, **Pull requests** and **Commit statuses** say **Read-only**
   (**Metadata** is added by GitHub). Leave everything else at **No access**.
4. Click **Generate token** and copy it. It starts with `github_pat_`.

Portly refuses classic tokens (`ghp_…`): the only classic scope that reaches private repositories
can also change all of them. A token covers one account or organization.

## 2. Add it to Portly

1. Open **Settings → Accounts**.
2. Under **Add a connection**, click the **GitHub repositories** tile.
3. Paste the token and click **Save token**. Portly asks GitHub for one repository first and stores
   the token only if that works. It then shows under **Connected accounts** as **Connected**.

**Manage** replaces the token, **Test** asks GitHub whether it still works, and **Remove** deletes it
from Portly. Removing it changes nothing on GitHub, so revoke it there too if you no longer want it.

## 3. Add a GitHub widget

On the dashboard press `e` (or click **Edit**) → **Add widget** → **GitHub**. Its settings (gear
icon) choose:

- **Sort repositories by**: **Attention** (failing CI, then running, then the most recently pushed),
  **Last push** or **Name**. Also in the widget's ↕ menu.
- **Show archived repositories** and **Show forks**, both off at first.

The board shows up to 500 repositories, the most recently pushed first, and says so if you have more.

### What the dot means

| Dot | Meaning |
| --- | --- |
| Solid green circle | CI passed |
| Solid red square | CI failed |
| Dashed amber circle | CI is running |
| Hollow gray circle | This commit has no CI checks |
| Dotted gray circle | Portly can't read the result with this token |

A dotted dot is not a passing or a missing check: it means GitHub didn't give Portly the result, so
it is unknown. The widget says so under the list.

### Open in GitHub Desktop

The browser asks once whether it may open GitHub Desktop, then Desktop opens the repository, or
offers to clone it if this PC doesn't have it. Nothing happens on a PC without GitHub Desktop.

## Keeping the token safe

- It can read **all** of your repositories, private code included. It can't change anything. Treat
  it like a password.
- On a PC running Portly it is stored encrypted in the vault (secret `github:token`), protected by a
  key only your Windows account can unlock. On the browser-only site it is stored in that browser,
  **not encrypted**, on the site's shared address: read
  [what that means](static-build.md#where-your-data-lives) before using it there.
- It is sent only to `api.github.com`, never back to the browser from the server, never to the log,
  and never into **Settings → Import & export** files.
- If you think it leaked, delete it in GitHub under **Settings → Developer settings → Personal access
  tokens → Fine-grained tokens**. It stops working at once.
- It expires after 90 days. Portly then shows **GitHub token rejected**: create a new one and paste it
  under **Manage**.

## Troubleshooting

| You see | Meaning and fix |
| --- | --- |
| **"GitHub rejected this token"** when saving | It was copied partly, has expired, or was deleted. Copy it again, or create a new one. |
| **"Classic tokens can also change every repository"** | Create a fine-grained token (step 1). |
| **"That doesn't look like a GitHub fine-grained token"** | The text has spaces or isn't a token. It starts with `github_pat_`. |
| **"…it can't see any repositories"** | The token was created without **All repositories**. Create a new one (step 1). |
| **"…it may not read Issues"** (or another permission), when saving or in the widget as **GitHub token needs more access** | Set that permission to **Read-only** on the token in GitHub, or create a new one. |
| Widget: **Connect GitHub** | No token is saved yet. Follow step 2. |
| Widget: **GitHub token rejected** | It expired or was deleted. Create a new one and use **Manage → Replace token**. |
| **Saved credentials are locked** | See [Vault locked](troubleshooting.md#vault-locked); after **Reset credentials**, connect GitHub again. |
| **"GitHub is limiting requests. Try again in N s."** | Portly waits for the time GitHub asks; the widget keeps the last list meanwhile. |
| A repository is missing | Archived repositories and forks are hidden until you turn them on. Repositories of an organization or someone else's are not listed: the board shows your own. |
| **N repositories could not be read** | GitHub listed them but refused or garbled their details. The rest of the board is unaffected. |

The widget refreshes every 5 minutes while the page is visible and when you return to the tab. More
help: [troubleshooting](troubleshooting.md).
