/**
 * GitHub as a connection in Settings → Accounts, for launch pad sync through a private repository
 * (docs/design/launchpad-sync-github.md). Browser backend only. Modeled on Todoist: the repository
 * (`owner/name`) and a fine-grained personal access token, both write-only and checked with GitHub
 * before they are saved, and a row under "Connected accounts" with Manage (replace both) and Remove.
 *
 * Launch pad sync uses them a few seconds after they are saved; the row shows its status line and
 * Sync now (`LaunchpadSync.tsx`). A browser syncs through one connection: while a Microsoft
 * connection has the Launch pad sync service on, the form says so and does not save.
 */
import { useState, type FormEvent } from 'react';
import { RefreshCw, Save, Settings2, Trash } from 'lucide-react';
import { isApiError } from '../../../api/client.ts';
import { useRemoveGitHubSync, useSaveGitHubSync } from '../../../api/githubSync.ts';
import type { LaunchpadSyncInfo } from '../../../api/launchpadSync.ts';
import { Banner } from '../../../ui/Banner.tsx';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { Input, PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { errorMessage, toast, toastError } from '../../../ui/toast.ts';
import { connectionInfo } from './connections.ts';
import { SyncStatusLine, otherSyncConnection, useSyncConnections } from './LaunchpadSync.tsx';
import styles from '../../../styles/settings.module.css';

/** GitHub's page for a new private repository. */
export const GITHUB_NEW_REPOSITORY_URL = 'https://github.com/new?name=portly-sync&visibility=private';
/** GitHub's page for a new fine-grained token. */
export const GITHUB_FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Same shape checks as the backend (paste mistakes are caught before a round trip). */
const TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const CLASSIC_PATTERN = /^(?:ghp_|gho_|ghu_|ghs_|[0-9a-f]{40}$)/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function cleanGitHubToken(raw: string): string {
  return raw.trim().replace(/^(?:bearer|token)\s+/i, '');
}


type Errors = { repository?: string; token?: string };

/** A refusal about the repository: a field list naming it, or GitHub's refusal with `field: 'repository'`. */
function aboutRepository(details: unknown): boolean {
  if (Array.isArray(details)) return details.some((d) => typeof d === 'object' && d !== null && (d as { path?: unknown }).path === 'repository');
  return typeof details === 'object' && details !== null && (details as { field?: unknown }).field === 'repository';
}

/** Which repository and token to create, and the form that saves (or replaces) them. */
export function GitHubSyncForm({ onSaved, replacing = false }: { onSaved?(): void; replacing?: boolean }) {
  const save = useSaveGitHubSync();
  const [repository, setRepository] = useState('');
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  // One sync connection per browser: a Microsoft connection with launch pad sync blocks this one.
  const syncElsewhere = otherSyncConnection(useSyncConnections(), { github: true });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (syncElsewhere !== null) return;
    const repo = repository.trim();
    const cleaned = cleanGitHubToken(token);
    const found: Errors = {};
    if (!REPOSITORY_PATTERN.test(repo)) found.repository = 'Enter the repository as owner/name, for example octo-user/portly-sync.';
    if (cleaned === '') found.token = 'Paste your GitHub token.';
    else if (CLASSIC_PATTERN.test(cleaned)) found.token = 'Classic tokens can reach every repository of your account. Create a fine-grained token limited to the sync repository.';
    else if (!TOKEN_PATTERN.test(cleaned)) found.token = "That doesn't look like a GitHub fine-grained token. It starts with github_pat_ and has no spaces.";
    setErrors(found);
    if (found.repository !== undefined || found.token !== undefined) return;
    try {
      await save.mutateAsync({ repository: repo, token: cleaned });
      setRepository('');
      setToken('');
      toast.success(replacing ? 'GitHub sync settings updated.' : 'GitHub connected.');
      onSaved?.();
    } catch (err) {
      // 422 = a malformed repository, or GitHub refused the token or repository; show it next to the fields.
      if (isApiError(err, 'validation_failed')) setErrors(aboutRepository(err.details) ? { repository: errorMessage(err) } : { token: errorMessage(err) });
      else toastError(err, 'The GitHub settings could not be saved.');
    }
  };

  return (
    <div className={styles.formGrid}>
      <p className={styles.intro}>
        Keeps your launch pad (groups, bookmarks and custom icons) in a private repository in your GitHub account. Every change is a
        commit, so the repository's history keeps old launch pads until you delete the repository. The repository name and token are
        stored only in this browser, not encrypted, are sent only to api.github.com and are not included in exports.
      </p>
      {syncElsewhere !== null ? (
        <Banner tone="warning" title={`Launch pad sync already uses ${syncElsewhere}`}>
          A browser syncs through one connection. To sync through GitHub instead, turn Launch pad sync off for {syncElsewhere} under
          Manage first.
        </Banner>
      ) : null}
      <ol className={styles.steps} aria-label="What to create on GitHub">
        <li>
          Create an empty <strong>private</strong> repository (
          <ExternalLink href={GITHUB_NEW_REPOSITORY_URL} showIcon>
            open it directly
          </ExternalLink>
          ). Portly keeps only its own files in it.
        </li>
        <li>
          Create a <strong>fine-grained token</strong> (
          <ExternalLink href={GITHUB_FINE_GRAINED_TOKEN_URL} showIcon>
            open it directly
          </ExternalLink>
          ). Under <strong>Repository access</strong> choose <strong>Only select repositories</strong> and pick that repository. Under{' '}
          <strong>Repository permissions</strong> set <strong>Contents</strong> to <strong>Read and write</strong>. Leave everything else
          at No access. Classic tokens are refused.
        </li>
        <li>Enter both below and click Save. Portly checks them with GitHub before storing them.</li>
      </ol>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} aria-label="GitHub sync settings" noValidate>
        <Field label="Repository (owner/name)" error={errors.repository ?? null}>
          <Input
            value={repository}
            onChange={(event) => {
              setRepository(event.currentTarget.value);
              if (errors.repository) setErrors({ ...errors, repository: undefined });
            }}
            placeholder="octo-user/portly-sync"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
          />
        </Field>
        <Field label={replacing ? 'New token' : 'Fine-grained token'} error={errors.token ?? null}>
          <PasswordInput
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              if (errors.token) setErrors({ ...errors, token: undefined });
            }}
            placeholder="github_pat_…"
            autoComplete="off"
            maxLength={300}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking with GitHub…' : undefined}>
          <Button
            type="submit"
            variant="primary"
            icon={Save}
            loading={save.isPending}
            disabled={repository.trim() === '' || token.trim() === '' || syncElsewhere !== null}
          >
            {replacing ? 'Replace' : 'Save'}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

const GITHUB = connectionInfo('github');

/** GitHub under "Connected accounts" (the list shows it only while a repository and token are saved). */
export function GitHubSyncRow({ sync = null }: { sync?: LaunchpadSyncInfo | null }) {
  const remove = useRemoveGitHubSync();
  const [managing, setManaging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className={styles.accountRow}>
      <LetterTile label={GITHUB.title} color={GITHUB.mark?.color} size={36} />
      <div className={styles.accountMain}>
        <div className={styles.accountName}>
          <span>GitHub</span>
          <Badge tone="neutral">Token saved</Badge>
        </div>
        <span className={styles.itemMeta}>GitHub · fine-grained token · private repository</span>
        <ul className={styles.serviceChips} aria-label="GitHub services in use">
          <li className={styles.serviceChip}>
            <RefreshCw aria-hidden="true" />
            Launch pad sync
          </li>
        </ul>
        {sync ? <SyncStatusLine info={sync} /> : null}
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={() => setManaging(true)} aria-label="Manage GitHub">
          Manage
        </Button>
        <IconButton icon={Trash} size="sm" aria-label="Remove GitHub" onClick={() => setConfirmRemove(true)} />
      </div>
      <Dialog open={managing} onOpenChange={setManaging} title="Manage GitHub" description="Launch pad sync through a private repository." size="lg">
        {managing ? (
          <FieldGroup legend="Repository and token">
            <GitHubSyncForm replacing onSaved={() => setManaging(false)} />
          </FieldGroup>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove GitHub?"
        description="Portly deletes the saved repository name and token from this browser, and launch pad sync stops here; your launch pad stays in this browser. The repository stays in your GitHub account with its history: delete it there if you no longer want it, and revoke the token in GitHub's settings."
        confirmLabel="Remove GitHub"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('GitHub removed.');
          } catch (err) {
            toastError(err, 'The GitHub settings could not be removed.');
            throw err;
          }
        }}
      />
    </div>
  );
}
