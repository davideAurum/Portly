/**
 * GitHub repositories as a connection in Settings → Accounts (§7 GitHub, §10.5): the read-only
 * token behind the GitHub widget, its row under "Connected accounts" (status, Manage, Test, Remove)
 * and the Manage dialog. Modeled on Todoist. The token is write-only, checked with GitHub before it
 * is saved, and lives where `/api/github/token` keeps it: the vault on the server, this browser's
 * storage on the in-browser backend.
 *
 * Not launch pad sync (`GitHubSync.tsx`): that token reaches one repository and may write to it.
 * This one reads every repository of the account and may change nothing. The guide is
 * docs/setup/github.md.
 */
import { useState, type FormEvent } from 'react';
import { FlaskConical, FolderGit2, Save, Settings2, Trash } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { cleanGitHubToken, gitHubTokenProblem } from '@portly/shared';
import { isApiError } from '../../../api/client.ts';
import { fetchGitHubBoard, useGitHubBoard, useGitHubToken, useRemoveGitHubToken, useSaveGitHubToken } from '../../../api/github.ts';
import { qk } from '../../../api/keys.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Banner } from '../../../ui/Banner.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { SkeletonLines } from '../../../ui/Skeleton.tsx';
import { errorMessage, toast, toastError } from '../../../ui/toast.ts';
import { connectionInfo } from './connections.ts';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';

/**
 * GitHub's page for a new fine-grained token, filled in with the read-only permissions the board
 * needs. No address can choose "All repositories": the steps ask for that.
 */
export const GITHUB_STATUS_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Portly%20status%20board&description=Read-only%20status%20board%20for%20Portly&expires_in=90&contents=read&issues=read&pull_requests=read&statuses=read';

function repositories(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/** Where the token lives: the server keeps it in the encrypted vault, the in-browser backend in this browser's storage. */
function tokenStorageNote(): string {
  return getCapabilities().vault
    ? 'The GitHub widget reads your repositories with a read-only token. It is stored encrypted on this PC and never shown again.'
    : 'The GitHub widget reads your repositories with a read-only token. It is stored only in this browser on this device, not encrypted, and is sent only to api.github.com; it is not included in exports.';
}

export type GitHubStatusState = 'loading' | 'unavailable' | 'disconnected' | 'locked' | 'rejected' | 'connected';

/** Whether GitHub is connected, and whether the saved token still works. */
export function useGitHubStatus(): { status: GitHubStatusState; repoCount: number | null } {
  const token = useGitHubToken();
  const locked = useVaultLocked();
  const configured = token.data?.configured === true;
  const board = useGitHubBoard(configured && !locked);
  if (token.data === undefined) return { status: token.isError ? 'unavailable' : 'loading', repoCount: null };
  if (!configured) return { status: 'disconnected', repoCount: null };
  // The token is stored but can't be decrypted: nothing works until credentials are reset.
  if (locked) return { status: 'locked', repoCount: null };
  if (isApiError(board.error, 'not_configured')) return { status: 'rejected', repoCount: null };
  return { status: 'connected', repoCount: board.data?.total ?? null };
}

function StatusBadge({ status }: { status: GitHubStatusState }) {
  switch (status) {
    case 'locked':
      return <Badge tone="warning">Locked</Badge>;
    case 'rejected':
      return <Badge tone="danger">Token refused</Badge>;
    case 'unavailable':
      return <Badge tone="danger">Status unavailable</Badge>;
    case 'disconnected':
      return <Badge tone="neutral">Not connected</Badge>;
    case 'connected':
      return (
        <Badge tone="success" dot>
          Connected
        </Badge>
      );
    default:
      return null;
  }
}

/** Which token to create, and the form that saves (or replaces) it. */
export function GitHubStatusTokenForm({ onSaved, replacing = false }: { onSaved?(): void; replacing?: boolean }) {
  const save = useSaveGitHubToken();
  const locked = useVaultLocked();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = cleanGitHubToken(token);
    const problem = cleaned === '' ? 'Paste your GitHub token.' : gitHubTokenProblem(cleaned);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await save.mutateAsync(cleaned);
      setToken('');
      toast.success(replacing ? 'GitHub token updated.' : 'GitHub repositories connected.');
      onSaved?.();
    } catch (err) {
      // 422 = GitHub refused the token, or it can't read the board; show it next to the field.
      if (isApiError(err, 'validation_failed')) setError(errorMessage(err));
      else toastError(err, 'The token could not be saved.');
    }
  };

  return (
    <div className={styles.formGrid}>
      <p className={styles.intro}>{tokenStorageNote()}</p>
      <ol className={styles.steps} aria-label="What to create on GitHub">
        <li>
          Create a <strong>fine-grained token</strong> (
          <ExternalLink href={GITHUB_STATUS_TOKEN_URL} showIcon>
            open it directly
          </ExternalLink>
          ). This link fills in the name, a 90-day expiry and the permissions.
        </li>
        <li>
          Under <strong>Repository access</strong> choose <strong>All repositories</strong>. Check that <strong>Contents</strong>,{' '}
          <strong>Issues</strong>, <strong>Pull requests</strong> and <strong>Commit statuses</strong> say <strong>Read-only</strong>. Leave
          everything else at No access. Classic tokens are refused.
        </li>
        <li>Paste it below and click Save. Portly checks it with GitHub before storing it.</li>
      </ol>
      <p className={styles.intro}>
        The token can read all of your repositories, private code included, so treat it like a password. It can't change anything. It
        isn't the launch pad sync token: that one reaches a single repository and may write to it.
      </p>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} aria-label="GitHub repositories token" noValidate>
        <Field label={replacing ? 'Replace token' : 'Fine-grained token'} error={error}>
          <PasswordInput
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={replacing ? 'Paste a new token to replace the saved one' : 'github_pat_…'}
            autoComplete="off"
            maxLength={300}
            disabled={locked}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking the token with GitHub…' : undefined}>
          <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={locked || token.trim() === ''}>
            {replacing ? 'Replace token' : 'Save token'}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

const CONNECTION = connectionInfo('github-status');

/** GitHub repositories under "Connected accounts" (only while a token is saved). */
export function GitHubStatusRow({ onManage }: { onManage(): void }) {
  const { status } = useGitHubStatus();
  const remove = useRemoveGitHubToken();
  const client = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const runTest = async () => {
    setTesting(true);
    try {
      const board = await fetchGitHubBoard();
      client.setQueryData(qk.github.board(), board);
      toast.success('GitHub is working.', { description: `${repositories(board.total)} found.` });
    } catch (error) {
      toastError(error, 'GitHub has a problem.');
      await client.invalidateQueries({ queryKey: qk.github.board() });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={styles.accountRow}>
      <LetterTile label={CONNECTION.title} color={CONNECTION.mark?.color} size={36} />
      <div className={styles.accountMain}>
        <div className={styles.accountName}>
          <span>{CONNECTION.title}</span>
          <StatusBadge status={status} />
        </div>
        <span className={styles.itemMeta}>GitHub · read-only fine-grained token</span>
        {status === 'rejected' ? <span className={styles.itemMeta}>GitHub refused the saved token, or it may not read the board. Paste a new one under Manage.</span> : null}
        <ul className={styles.serviceChips} aria-label="GitHub repositories services in use">
          <li className={styles.serviceChip}>
            <FolderGit2 aria-hidden="true" />
            Status board
          </li>
        </ul>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={onManage} aria-label="Manage GitHub repositories">
          Manage
        </Button>
        <IconButton icon={FlaskConical} size="sm" aria-label="Test GitHub repositories" loading={testing} disabled={status === 'locked'} onClick={() => void runTest()} />
        <IconButton icon={Trash} size="sm" aria-label="Remove GitHub repositories" onClick={() => setConfirmRemove(true)} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove GitHub repositories?"
        description="Portly deletes the saved token. GitHub widgets stop showing repositories until you connect again. Nothing changes on GitHub: revoke the token there too if you no longer want it."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('GitHub repositories removed.');
          } catch (err) {
            toastError(err, 'The token could not be removed.');
            throw err;
          }
        }}
      />
    </div>
  );
}

/** Manage GitHub repositories: replace the token. */
export function GitHubStatusManageDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Manage GitHub repositories" description="The status board, through a read-only token." size="lg">
      {open ? <ManageBody onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ManageBody({ onDone }: { onDone(): void }) {
  const { status, repoCount } = useGitHubStatus();
  return (
    <div className={styles.dialogStack}>
      {status === 'loading' ? <SkeletonLines lines={2} /> : null}
      {status === 'locked' ? (
        <Banner tone="warning" title="Saved credentials are locked">
          Portly can't read its encryption key, so the GitHub token can't be used or replaced. Reset credentials with the banner on this
          page, then connect GitHub again.
        </Banner>
      ) : null}
      {status === 'rejected' ? (
        <Banner tone="danger" title="GitHub refused the saved token">
          It may have expired, been revoked, or lost a permission. Paste a new token below.
        </Banner>
      ) : null}
      {status === 'connected' && repoCount !== null ? (
        <p className={styles.intro} role="status">
          Working: {repositories(repoCount)} found.
        </p>
      ) : null}
      <FieldGroup legend="Token">
        <GitHubStatusTokenForm replacing={status !== 'disconnected'} onSaved={onDone} />
      </FieldGroup>
    </div>
  );
}
