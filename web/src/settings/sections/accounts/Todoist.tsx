/**
 * Todoist as a connection in Settings → Accounts (§4.6, §7 Todoist, §10.5): the API token
 * (write-only; checked with Todoist before it is saved), its row under "Connected accounts"
 * (status, Manage, Test, Remove) and the Manage dialog with the token and the default filter used
 * by Todoist widgets without their own filter.
 *
 * Todoist is not an account row: the token stays where `/api/todoist/token` keeps it (the vault
 * on the server; this browser's storage on the in-browser backend). The full guide is
 * docs/setup/todoist.md; without a vault (the in-browser backend) Todoist's own help article is
 * linked instead (the site cannot open a guide that lives in the Portly folder on a PC).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { FlaskConical, ListChecks, RotateCcw, Save, Settings2, Trash } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TODOIST_FILTER, TodoistFilterSchema } from '@portly/shared';
import { isApiError } from '../../../api/client.ts';
import { qk } from '../../../api/keys.ts';
import { useSettings, useUpdateSettings } from '../../../api/settings.ts';
import { fetchTodoistProjects, useRemoveTodoistToken, useSaveTodoistToken, useTodoistProjects, useTodoistToken } from '../../../api/todoist.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Banner } from '../../../ui/Banner.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { Input, PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { SkeletonLines } from '../../../ui/Skeleton.tsx';
import { errorMessage, toast, toastError } from '../../../ui/toast.ts';
import { FILTER_PRESETS } from '../../../widgets/todoist/model.ts';
import { connectionInfo } from './connections.ts';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';
import todoistStyles from '../../../widgets/todoist/Todoist.module.css';

export const TODOIST_DEVELOPER_SETTINGS_URL = 'https://app.todoist.com/app/settings/integrations/developer';
export const TODOIST_FILTER_HELP_URL = 'https://www.todoist.com/help/articles/introduction-to-filters-V98wIH';
/** Todoist's own "Find your API token" help article, linked from the browser-only build (it has no Portly folder). */
export const TODOIST_TOKEN_HELP_URL = 'https://www.todoist.com/help/articles/find-your-api-token-Jpzx9IIlB';

/** Same sanity check as the server (paste mistakes are caught before a round trip). */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,200}$/;

export function cleanToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, '');
}

/** Where the token lives: the server keeps it in the encrypted vault, the in-browser backend in this browser's storage. */
function tokenStorageNote(): string {
  return getCapabilities().vault
    ? 'Portly reads and completes your tasks with your personal API token. It is stored encrypted on this PC and never shown again.'
    : 'Portly reads and completes your tasks with your personal API token. It is stored only in this browser on this device, not encrypted, and is sent only to api.todoist.com; it is not included in exports.';
}

export type TodoistStatus = 'loading' | 'unavailable' | 'disconnected' | 'locked' | 'rejected' | 'connected';

/** Whether Todoist is connected, and whether the saved token still works. */
export function useTodoistStatus(): { status: TodoistStatus; projectCount: number | null } {
  const token = useTodoistToken();
  const locked = useVaultLocked();
  const configured = token.data?.configured === true;
  const projects = useTodoistProjects(configured && !locked);
  if (token.data === undefined) return { status: token.isError ? 'unavailable' : 'loading', projectCount: null };
  if (!configured) return { status: 'disconnected', projectCount: null };
  // The token is stored but can't be decrypted: nothing works until credentials are reset.
  if (locked) return { status: 'locked', projectCount: null };
  const rejected =
    isApiError(projects.error, 'not_configured') && (projects.error.details as { reason?: unknown } | undefined)?.reason === 'token_rejected';
  if (rejected) return { status: 'rejected', projectCount: null };
  return { status: 'connected', projectCount: projects.data?.length ?? null };
}

function TodoistStatusBadge({ status }: { status: TodoistStatus }) {
  switch (status) {
    case 'locked':
      return <Badge tone="warning">Locked</Badge>;
    case 'rejected':
      return <Badge tone="danger">Token rejected</Badge>;
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

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Where to find the token, and the form that saves (or replaces) it. */
export function TodoistTokenForm({ onSaved, replacing = false }: { onSaved?(): void; replacing?: boolean }) {
  const save = useSaveTodoistToken();
  const locked = useVaultLocked();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = cleanToken(token);
    if (cleaned === '') {
      setError('Paste your Todoist API token.');
      return;
    }
    if (!TOKEN_PATTERN.test(cleaned)) {
      setError("That doesn't look like a Todoist API token. It is a long string of letters and digits (40 characters) without spaces.");
      return;
    }
    setError(null);
    try {
      await save.mutateAsync(cleaned);
      setToken('');
      toast.success(replacing ? 'Todoist token updated.' : 'Todoist connected.');
      onSaved?.();
    } catch (err) {
      // 422 = Todoist rejected the token (or its shape); show it next to the field.
      if (isApiError(err, 'validation_failed')) setError(errorMessage(err));
      else toastError(err, 'The token could not be saved.');
    }
  };

  return (
    <div className={styles.formGrid}>
      <p className={styles.intro}>{tokenStorageNote()}</p>
      <ol className={styles.steps} aria-label="Where to find the token">
        <li>
          In Todoist open <strong>Settings → Integrations → Developer</strong>{' '}
          (
          <ExternalLink href={TODOIST_DEVELOPER_SETTINGS_URL} showIcon>
            open it directly
          </ExternalLink>
          ).
        </li>
        <li>
          Click <strong>Copy API token</strong>.
        </li>
        <li>Paste it below and click Save. Portly checks it with Todoist before storing it.</li>
      </ol>
      <p className={styles.intro}>
        The token gives full access to your Todoist account — treat it like a password.{' '}
        {getCapabilities().vault ? (
          <>
            The step-by-step guide is <code className={todoistStyles.code}>docs/setup/todoist.md</code> in the Portly folder.
          </>
        ) : (
          <>
            Todoist's help shows the same steps:{' '}
            <ExternalLink href={TODOIST_TOKEN_HELP_URL} showIcon>
              Find your API token
            </ExternalLink>
            .
          </>
        )}
      </p>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} aria-label="Todoist API token">
        <Field label={replacing ? 'Replace token' : 'API token'} error={error}>
          <PasswordInput
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={replacing ? 'Paste a new token to replace the saved one' : 'Paste your API token'}
            autoComplete="off"
            maxLength={250}
            disabled={locked}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking the token with Todoist…' : undefined}>
          <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={locked || token.trim() === ''}>
            {replacing ? 'Replace token' : 'Save token'}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default filter
// ---------------------------------------------------------------------------

function DefaultFilterForm() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const saved = settings.data?.todoist.defaultFilter;
  const [draft, setDraft] = useState(saved ?? '');
  const [error, setError] = useState<string | null>(null);

  // Follow the stored value until the user starts editing.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty && saved !== undefined) setDraft(saved);
  }, [saved, dirty]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = TodoistFilterSchema.safeParse(draft);
    if (!parsed.success) {
      setError(draft.trim() === '' ? 'Enter a filter, or reset to the default.' : 'Keep the filter under 1024 characters.');
      return;
    }
    setError(null);
    update.mutate(
      { todoist: { defaultFilter: parsed.data } },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success('Default filter saved.');
        },
      },
    );
  };

  const reset = () => {
    setError(null);
    update.mutate(
      { todoist: { defaultFilter: null } },
      {
        onSuccess: () => {
          setDirty(false);
          setDraft(DEFAULT_TODOIST_FILTER);
        },
      },
    );
  };

  if (settings.data === undefined) return <SkeletonLines lines={2} />;
  const unchanged = saved !== undefined && draft.trim() === saved;

  return (
    <form className={styles.formGrid} onSubmit={submit} aria-label="Default Todoist filter">
      <Field
        label="Filter"
        error={error}
        help={
          <>
            Todoist filter syntax, e.g. <code className={todoistStyles.code}>today | overdue</code> or{' '}
            <code className={todoistStyles.code}>#Work &amp; 7 days</code>.{' '}
            <ExternalLink href={TODOIST_FILTER_HELP_URL} showIcon>
              Filter guide
            </ExternalLink>
          </>
        }
      >
        <Input
          value={draft}
          maxLength={1100}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setDirty(true);
            if (error) setError(null);
          }}
        />
      </Field>
      <div className={todoistStyles.presets} role="group" aria-label="Filter presets">
        {FILTER_PRESETS.map((preset) => (
          <Button
            key={preset.query}
            size="sm"
            variant={draft.trim() === preset.query ? 'primary' : 'secondary'}
            aria-pressed={draft.trim() === preset.query}
            title={preset.query}
            onClick={() => {
              setDraft(preset.query);
              setDirty(true);
              setError(null);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <FormFooter status={update.isError ? errorMessage(update.error, 'Not saved.') : undefined}>
        <Button variant="ghost" icon={RotateCcw} onClick={reset} disabled={update.isPending || saved === DEFAULT_TODOIST_FILTER}>
          Reset
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending} disabled={unchanged}>
          Save
        </Button>
      </FormFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Connected row and Manage
// ---------------------------------------------------------------------------

const TODOIST = connectionInfo('todoist');

/** Todoist under "Connected accounts" (only while a token is saved). */
export function TodoistRow({ onManage }: { onManage(): void }) {
  const { status } = useTodoistStatus();
  const remove = useRemoveTodoistToken();
  const client = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const runTest = async () => {
    setTesting(true);
    try {
      const projects = await fetchTodoistProjects();
      client.setQueryData(qk.todoist.projects(), projects);
      toast.success('Todoist is working.', { description: `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} found.` });
    } catch (error) {
      toastError(error, 'Todoist has a problem.');
      await client.invalidateQueries({ queryKey: qk.todoist.projects() });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={styles.accountRow}>
      <LetterTile label={TODOIST.title} color={TODOIST.mark?.color} size={36} />
      <div className={styles.accountMain}>
        <div className={styles.accountName}>
          <span>Todoist</span>
          <TodoistStatusBadge status={status} />
        </div>
        <span className={styles.itemMeta}>Todoist · API token</span>
        {status === 'rejected' ? <span className={styles.itemMeta}>Todoist no longer accepts the saved token. Paste the current one under Manage.</span> : null}
        <ul className={styles.serviceChips} aria-label="Todoist services in use">
          <li className={styles.serviceChip}>
            <ListChecks aria-hidden="true" />
            Tasks
          </li>
        </ul>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={onManage} aria-label="Manage Todoist">
          Manage
        </Button>
        <IconButton icon={FlaskConical} size="sm" aria-label="Test Todoist" loading={testing} disabled={status === 'locked'} onClick={() => void runTest()} />
        <IconButton icon={Trash} size="sm" aria-label="Remove Todoist" onClick={() => setConfirmRemove(true)} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove Todoist?"
        description="Portly deletes the saved API token. Todoist widgets stop showing tasks until you connect Todoist again. Nothing is changed in your Todoist account."
        confirmLabel="Remove Todoist"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('Todoist removed.');
          } catch (err) {
            toastError(err, 'The token could not be removed.');
            throw err;
          }
        }}
      />
    </div>
  );
}

/** Manage Todoist: replace the token, and the default filter. */
export function TodoistManageDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Manage Todoist" description="Your tasks, through your personal API token." size="lg">
      {open ? <TodoistManageBody /> : null}
    </Dialog>
  );
}

function TodoistManageBody() {
  const { status, projectCount } = useTodoistStatus();
  return (
    <div className={styles.dialogStack}>
      {status === 'loading' ? <SkeletonLines lines={2} /> : null}
      {status === 'locked' ? (
        <Banner tone="warning" title="Saved credentials are locked">
          Portly can't read its encryption key, so the Todoist token can't be used or replaced. Reset credentials with the banner on
          this page, then connect Todoist again.
        </Banner>
      ) : null}
      {status === 'rejected' ? (
        <Banner tone="danger" title="Todoist rejected the saved token">
          It was probably reset or revoked in Todoist. Paste the current token below.
        </Banner>
      ) : null}
      {status === 'connected' && projectCount !== null ? (
        <p className={styles.intro} role="status">
          Working — {projectCount} {projectCount === 1 ? 'project' : 'projects'} found.
        </p>
      ) : null}
      <FieldGroup legend="API token">
        <TodoistTokenForm replacing={status !== 'disconnected'} />
      </FieldGroup>
      <FieldGroup legend="Default filter" description="Used by every Todoist widget that doesn't set its own filter.">
        <DefaultFilterForm />
      </FieldGroup>
    </div>
  );
}
