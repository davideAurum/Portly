/**
 * GitHub as a connection in Settings → Accounts, for launch pad sync through secret gists
 * (docs/design/launchpad-sync-gist.md). Browser backend only. Modeled on Todoist: a write-only
 * personal access token (checked with GitHub before it is saved), its row under "Connected
 * accounts" with Manage (replace the token) and Remove.
 *
 * The sync engine is not wired up yet, so the form and the row say that saving the token syncs
 * nothing so far.
 */
import { useState, type FormEvent } from 'react';
import { RefreshCw, Save, Settings2, Trash } from 'lucide-react';
import { isApiError } from '../../../api/client.ts';
import { useRemoveGistToken, useSaveGistToken } from '../../../api/gistSync.ts';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { errorMessage, toast, toastError } from '../../../ui/toast.ts';
import { connectionInfo } from './connections.ts';
import styles from '../../../styles/settings.module.css';

/** GitHub's page for a new fine-grained token. */
export const GITHUB_FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
/** GitHub's page for a new classic token, with only the gist scope ticked. */
export const GITHUB_CLASSIC_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Portly%20launch%20pad%20sync';

/** Same shape check as the backend (paste mistakes are caught before a round trip). */
const TOKEN_PATTERN = /^(?:github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{30,255}|[0-9a-f]{40})$/;

export function cleanGistToken(raw: string): string {
  return raw.trim().replace(/^(?:bearer|token)\s+/i, '');
}

const NOT_WIRED_NOTE = 'Launch pad sync through GitHub is not switched on yet: for now Portly only checks and keeps the token.';

/** Which token to create, and the form that saves (or replaces) it. */
export function GitHubGistTokenForm({ onSaved, replacing = false }: { onSaved?(): void; replacing?: boolean }) {
  const save = useSaveGistToken();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = cleanGistToken(token);
    if (cleaned === '') {
      setError('Paste your GitHub token.');
      return;
    }
    if (!TOKEN_PATTERN.test(cleaned)) {
      setError("That doesn't look like a GitHub personal access token. It starts with github_pat_ (fine-grained) or ghp_ (classic) and has no spaces.");
      return;
    }
    setError(null);
    try {
      await save.mutateAsync(cleaned);
      setToken('');
      toast.success(replacing ? 'GitHub token updated.' : 'GitHub connected.');
      onSaved?.();
    } catch (err) {
      // 422 = GitHub refused the token, or it can do more than gists; show it next to the field.
      if (isApiError(err, 'validation_failed')) setError(errorMessage(err));
      else toastError(err, 'The token could not be saved.');
    }
  };

  return (
    <div className={styles.formGrid}>
      <p className={styles.intro}>
        Keeps your launch pad (groups, bookmarks and custom icons) in two secret gists in your GitHub account. Secret gists are
        unlisted, not private: anyone who has their address can read them. The token is stored only in this browser, not
        encrypted, is sent only to api.github.com and is not included in exports.
      </p>
      <p className={styles.intro}>{NOT_WIRED_NOTE}</p>
      <ol className={styles.steps} aria-label="Which token to create">
        <li>
          On GitHub, create a <strong>fine-grained token</strong> (
          <ExternalLink href={GITHUB_FINE_GRAINED_TOKEN_URL} showIcon>
            open it directly
          </ExternalLink>
          ). Under <strong>Account permissions</strong> set <strong>Gists</strong> to <strong>Read and write</strong>. Leave
          every other permission at No access, and repository access at public repositories.
        </li>
        <li>
          Or a <strong>classic token</strong> with only the <strong>gist</strong> scope (
          <ExternalLink href={GITHUB_CLASSIC_TOKEN_URL} showIcon>
            open it directly
          </ExternalLink>
          ). Portly refuses a classic token with any other scope.
        </li>
        <li>Paste it below and click Save. Portly checks it with GitHub before storing it.</li>
      </ol>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} aria-label="GitHub token">
        <Field label={replacing ? 'Replace token' : 'Personal access token'} error={error}>
          <PasswordInput
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={replacing ? 'Paste a new token to replace the saved one' : 'github_pat_… or ghp_…'}
            autoComplete="off"
            maxLength={300}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking the token with GitHub…' : undefined}>
          <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={token.trim() === ''}>
            {replacing ? 'Replace token' : 'Save token'}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

const GITHUB = connectionInfo('github');

/** GitHub under "Connected accounts" (the list shows it only while a token is saved). */
export function GitHubGistRow() {
  const remove = useRemoveGistToken();
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
        <span className={styles.itemMeta}>GitHub · personal access token · secret gists</span>
        <span className={styles.itemMeta}>{NOT_WIRED_NOTE}</span>
        <ul className={styles.serviceChips} aria-label="GitHub services in use">
          <li className={styles.serviceChip}>
            <RefreshCw aria-hidden="true" />
            Launch pad sync
          </li>
        </ul>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={() => setManaging(true)} aria-label="Manage GitHub">
          Manage
        </Button>
        <IconButton icon={Trash} size="sm" aria-label="Remove GitHub" onClick={() => setConfirmRemove(true)} />
      </div>
      <Dialog open={managing} onOpenChange={setManaging} title="Manage GitHub" description="Launch pad sync through secret gists." size="lg">
        {managing ? (
          <FieldGroup legend="Personal access token">
            <GitHubGistTokenForm replacing onSaved={() => setManaging(false)} />
          </FieldGroup>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove GitHub?"
        description="Portly deletes the saved token from this browser. The gists stay in your GitHub account: delete them there if you no longer want them, and revoke the token in GitHub's settings."
        confirmLabel="Remove GitHub"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('GitHub removed.');
          } catch (err) {
            toastError(err, 'The token could not be removed.');
            throw err;
          }
        }}
      />
    </div>
  );
}
