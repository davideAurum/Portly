/**
 * Settings → Todoist (§4.6, §7 Todoist, §10.5): the API token (write-only; checked with Todoist
 * before it is saved; removable with confirmation), where to find the token, and the default
 * filter used by Todoist widgets without their own filter. The full guide is docs/setup/todoist.md;
 * without a vault (the in-browser backend) the page links Todoist's own help article instead (the
 * site cannot open a guide that lives in the Portly folder on a PC). A locked vault is reset in
 * Settings → Accounts — on Portly's own page when this page
 * is the Pages site using Portly on this PC.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, RotateCcw, Save, Trash } from 'lucide-react';
import { DEFAULT_TODOIST_FILTER, TodoistFilterSchema } from '@portly/shared';
import { isApiError } from '../../api/client.ts';
import { useHealth } from '../../api/about.ts';
import { useSettings, useUpdateSettings } from '../../api/settings.ts';
import { useRemoveTodoistToken, useSaveTodoistToken, useTodoistProjects, useTodoistToken } from '../../api/todoist.ts';
import { getCapabilities } from '../../capabilities.ts';
import { safeHref } from '../../lib/openUrl.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, PasswordInput } from '../../ui/Input.tsx';
import { FormFooter, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import { errorMessage, toast, toastError } from '../../ui/toast.ts';
import { FILTER_PRESETS } from '../../widgets/todoist/model.ts';
import sectionStyles from '../../styles/settings.module.css';
import styles from '../../widgets/todoist/Todoist.module.css';

export const TODOIST_DEVELOPER_SETTINGS_URL = 'https://app.todoist.com/app/settings/integrations/developer';
export const TODOIST_FILTER_HELP_URL = 'https://www.todoist.com/help/articles/introduction-to-filters-V98wIH';
/** Todoist's own "Find your API token" help article, linked from the browser-only build (it has no Portly folder). */
export const TODOIST_TOKEN_HELP_URL = 'https://www.todoist.com/help/articles/find-your-api-token-Jpzx9IIlB';

/** Where the token lives: the server keeps it in the encrypted vault, the in-browser backend in this browser's storage. */
function tokenCardDescription(): string {
  return getCapabilities().vault
    ? 'Portly reads and completes your tasks with your personal API token. It is stored encrypted on this PC and never shown again.'
    : 'Portly reads and completes your tasks with your personal API token. It is stored only in this browser on this device, not encrypted, and is sent only to api.todoist.com; it is not included in exports.';
}

/** Same sanity check as the server (paste mistakes are caught before a round trip). */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,200}$/;

export function cleanToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, '');
}

export default function TodoistSettings() {
  const health = useHealth();
  const caps = getCapabilities();
  // No vault on the in-browser backend: the token can never be "locked".
  const locked = caps.vault && health.data?.vault === 'locked';
  return (
    <div className={sectionStyles.stack}>
      {locked ? (
        <Banner
          tone="warning"
          icon={KeyRound}
          title="Saved credentials are locked"
          actions={<OpenAccountsLink />}
        >
          Portly can't read its encryption key, so the Todoist token can't be used or replaced. Reset credentials in Settings →
          Accounts, then add your token here again.
        </Banner>
      ) : null}
      <TokenCard locked={locked} />
      <DefaultFilterCard />
    </div>
  );
}

function OpenAccountsLink() {
  return (
    <a className={styles.cta} href={safeHref('#/settings/accounts')}>
      Open Accounts
    </a>
  );
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

function TokenCard({ locked }: { locked: boolean }) {
  const status = useTodoistToken();
  const save = useSaveTodoistToken();
  const remove = useRemoveTodoistToken();
  const configured = status.data?.configured === true;
  const projects = useTodoistProjects(configured && !locked);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
      toast.success(configured ? 'Todoist token updated.' : 'Todoist connected.');
    } catch (err) {
      // 422 = Todoist rejected the token (or its shape); show it next to the field.
      if (isApiError(err, 'validation_failed')) setError(errorMessage(err));
      else toastError(err, 'The token could not be saved.');
    }
  };

  const tokenRejected =
    isApiError(projects.error, 'not_configured') && (projects.error.details as { reason?: unknown } | undefined)?.reason === 'token_rejected';

  let connection: ReactNode = null;
  if (status.data === undefined) {
    connection = status.isError ? <Badge tone="danger">Status unavailable</Badge> : null;
  } else if (!configured) {
    connection = <Badge tone="neutral">Not connected</Badge>;
  } else if (locked) {
    // The token is stored but can't be decrypted: nothing works until credentials are reset.
    connection = <Badge tone="warning">Locked</Badge>;
  } else if (tokenRejected) {
    connection = <Badge tone="danger">Token rejected</Badge>;
  } else {
    connection = (
      <Badge tone="success" dot>
        Connected
      </Badge>
    );
  }

  return (
    <SettingsCard
      title="Todoist API token"
      description={tokenCardDescription()}
      actions={connection}
    >
      {status.data === undefined && !status.isError ? <SkeletonLines lines={2} /> : null}
      {tokenRejected ? (
        <Banner tone="danger" title="Todoist rejected the saved token">
          It was probably reset or revoked in Todoist. Paste the current token below.
        </Banner>
      ) : null}
      {configured && !tokenRejected && projects.data ? (
        <p className={styles.connection} role="status">
          Working — {projects.data.length} {projects.data.length === 1 ? 'project' : 'projects'} found.
        </p>
      ) : null}

      <ol className={styles.steps} aria-label="Where to find the token">
        <li>
          In Todoist open <strong>Settings → Integrations → Developer</strong>{' '}
          (<ExternalLink href={TODOIST_DEVELOPER_SETTINGS_URL} showIcon>open it directly</ExternalLink>).
        </li>
        <li>
          Click <strong>Copy API token</strong>.
        </li>
        <li>Paste it below and click Save. Portly checks it with Todoist before storing it.</li>
      </ol>
      <p className={styles.hint}>
        The token gives full access to your Todoist account — treat it like a password.{' '}
        {getCapabilities().vault ? (
          <>
            The step-by-step guide is <code className={styles.code}>docs/setup/todoist.md</code> in the Portly folder.
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

      <form className={styles.formStack} onSubmit={(event) => void submit(event)} aria-label="Todoist API token">
        <Field label={configured ? 'Replace token' : 'API token'} error={error}>
          <PasswordInput
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={configured ? 'Paste a new token to replace the saved one' : 'Paste your API token'}
            autoComplete="off"
            maxLength={250}
            disabled={locked}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking the token with Todoist…' : undefined}>
          {configured ? (
            <Button variant="ghost" icon={Trash} onClick={() => setConfirmRemove(true)} disabled={remove.isPending}>
              Remove token
            </Button>
          ) : null}
          <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={locked || token.trim() === ''}>
            {configured ? 'Replace token' : 'Save token'}
          </Button>
        </FormFooter>
      </form>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the Todoist token?"
        description="Todoist widgets stop showing tasks until you add a token again. Nothing is changed in your Todoist account."
        confirmLabel="Remove token"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('Todoist token removed.');
          } catch (err) {
            toastError(err, 'The token could not be removed.');
            throw err;
          }
        }}
      />
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Default filter
// ---------------------------------------------------------------------------

function DefaultFilterCard() {
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

  const unchanged = saved !== undefined && draft.trim() === saved;

  return (
    <SettingsCard
      title="Default filter"
      description="Used by every Todoist widget that doesn't set its own filter."
    >
      {settings.data === undefined ? (
        <SkeletonLines lines={2} />
      ) : (
        <form className={styles.formStack} onSubmit={submit} aria-label="Default Todoist filter">
          <Field
            label="Filter"
            error={error}
            help={
              <>
                Todoist filter syntax, e.g. <code className={styles.code}>today | overdue</code> or{' '}
                <code className={styles.code}>#Work &amp; 7 days</code>.{' '}
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
          <div className={styles.presets} role="group" aria-label="Filter presets">
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
      )}
    </SettingsCard>
  );
}
