# Connect Todoist

Portly shows your Todoist tasks with a **personal API token** — there is no app registration and
no sign-in page. With it, the Todoist widget can:

| What | How |
| --- | --- |
| Show tasks | Any Todoist filter (`today \| overdue`, `#Work & p1`, `7 days`, …), up to 500 tasks per widget |
| Quick add | Natural language, parsed by Todoist: `Pay rent tomorrow 9am #Home p1` |
| Complete | One click, with **Undo**; recurring tasks move on to their next date |
| Show details | Due date (overdue in red), priority, project with its color, labels |

Portly talks only to Todoist's official API (`https://api.todoist.com/api/v1`) over HTTPS.

## 1. Copy your API token

1. Open Todoist in a browser: <https://app.todoist.com/app/> and sign in.
2. Click your **avatar** (top left) → **Settings**.
3. Open the **Integrations** tab, then the **Developer** tab
   (direct link: <https://app.todoist.com/app/settings/integrations/developer>).
4. Click **Copy API token**.

The Todoist desktop app has the same **Settings → Integrations → Developer** page.

## 2. Add it to Portly

1. Open Portly → **Settings → Todoist** (`http://localhost:5757/#/settings/todoist`).
2. Paste the token into **API token** (use the eye button to check what you pasted) and click
   **Save token**.
3. Portly first asks Todoist whether the token works and only then stores it. The card then shows
   **Connected** and how many projects it found.

To replace the token later, paste the new one into **Replace token**. **Remove token** (with
confirmation) deletes it from Portly; nothing changes in your Todoist account.

## 3. Add a Todoist widget

1. On the dashboard press `e` (or click **Edit**) → **Add widget** → **Todoist**.
2. Open the widget's settings (gear icon) to choose:
   - **Filter** — any Todoist filter query, or a preset: **Today** (`today | overdue`),
     **Overdue**, **Next 7 days** (`7 days`), **No date**, **Priority 1** (`p1`). Leave it empty to
     use the **Default filter** from Settings → Todoist (initially `today | overdue`).
   - **List title** — shown above the tasks (default: the preset's name or the query).
   - **Sort tasks by** — Todoist's own order, due date, or priority. Also available from the
     widget's ↕ menu.
   - **Show project** / **Show due date**.

Filter syntax is Todoist's own; see Todoist's
[introduction to filters](https://www.todoist.com/help/articles/introduction-to-filters-V98wIH).
Labels use `%` (for example `%errands`); Todoist still accepts the older `@` for now.

### Quick add

Type into **Add a task…** and press **Enter** (Esc clears the field). Todoist parses the text
exactly as in its own apps: dates and times (`tomorrow 5pm`, `every monday`), `#Project` (plus
`/Section`, as in `#Work /Meetings`), `%label`, and `p1`–`p3`. Portly then shows the task as
Todoist understood it.
If the new task doesn't match the widget's filter, the confirmation says so.

### Completing tasks

Click the round checkbox (or focus it with **Tab** and press **Space**). The task disappears at
once and a notification offers **Undo**, which reopens it. A **recurring** task isn't removed:
Todoist moves it to its next date and the notification tells you when that is (there is no Undo for
recurring tasks). Click a task's text to open it in Todoist.

## Keeping the token safe

- The token gives **full access to your Todoist account**. Treat it like a password: don't paste it
  into chats, screenshots or other websites.
- Portly stores it encrypted in its vault (secret `todoist:token`), protected by a key that only
  your Windows account can unlock. It is never sent back to the browser, never written to the log,
  and not included in **Settings → Import & export** files.
- It is sent only to `api.todoist.com`, in the `Authorization` header over HTTPS.
- If you think the token leaked: in Todoist go to **Settings → Integrations → Developer**, click
  **Issue a new API token** and confirm. The old token stops working immediately (for every app that
  used it); paste the new one into Portly.

## Troubleshooting

| You see | Meaning and fix |
| --- | --- |
| **"Todoist rejected this token"** when saving | The pasted text isn't a valid token (partly copied, an old token, or another service's key). Copy it again with **Copy API token**. |
| **"That doesn't look like a Todoist API token"** | The text contains spaces, quotes or a URL. The token is a single run of 40 letters and digits. |
| Widget: **Connect Todoist** | No token is saved yet. Follow step 2. |
| Widget: **Todoist token rejected** / Settings: **Token rejected** | The saved token was reset or revoked in Todoist. Copy the current one and use **Replace token**. |
| **Saved credentials are locked** | Portly can't read its encryption key (for example after moving the data folder to another PC or Windows user). See [Vault locked](troubleshooting.md#vault-locked); after **Reset credentials**, add the Todoist token again. |
| **"Todoist is rate limiting requests. Try again in N s."** | Todoist limits how many requests an account can make in a 15-minute window (other apps using your token count too). Portly pauses Todoist requests for the time Todoist asks for; the widget keeps showing the last list meanwhile. |
| Widget: **Check the filter** ("Todoist could not understand this filter") | The widget's filter (or your default filter) has a syntax error. **Edit filter** opens the widget's settings (**Edit default filter** opens Settings → Todoist). Try the query in Todoist's own filter editor, then paste the working one. |
| **"Todoist is having problems (HTTP 5xx)"** or **"The provider timed out"** | Todoist or your connection is having trouble. The widget keeps the last list (with a warning next to "Updated … ago") and retries on the next refresh. |
| A new task doesn't appear in the widget | It was added, but it doesn't match the widget's filter (for example it has no date and the filter is `today \| overdue`). |
| A completed task came back with a new date | It is a recurring task; completing it moves it to the next occurrence, as in Todoist. |
| Some tasks are missing from a very large list | A widget shows at most 500 tasks. Use a narrower filter. |

The widget refreshes every 5 minutes while the page is visible, when you return to the tab, and
after every change you make. More help: [troubleshooting](troubleshooting.md).
