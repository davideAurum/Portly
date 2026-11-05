/**
 * GitHub widget (§10.8 GitHub, §10.7): a status board of the account's repositories, with each
 * one's CI result, open pull requests and issues, latest release and last push.
 *
 * The menu on each row is the small "operations" button: it opens the repository in GitHub Desktop
 * (where Fetch, Pull and Push are), opens its pages on GitHub, or copies its clone address. Portly
 * itself changes nothing, on GitHub or on disk.
 *
 * A CI result this token can't read shows as unknown, with a note, and never as "no checks".
 * Not set up → CTA to GitHub repositories in Settings → Accounts; token refused → the same CTA;
 * vault locked → Accounts.
 */
import { useMemo } from 'react';
import {
  Archive,
  ArrowUpDown,
  CircleDot,
  Copy,
  Ellipsis,
  ExternalLink as ExternalLinkIcon,
  FolderSearch,
  GitFork,
  GitPullRequest,
  KeyRound,
  Lock,
  Monitor,
  Play,
  RefreshCw,
  Tag,
} from 'lucide-react';
import { GITHUB_WEB_URL, type GitHubBoard, type GitHubRepo } from '@portly/shared';
import { ApiError, isApiError } from '../../api/client.ts';
import { useGitHubBoard, useGitHubToken } from '../../api/github.ts';
import { WidgetActions } from '../../grid/WidgetContext.tsx';
import { copyText } from '../../lib/clipboard.ts';
import { useFormatters, type Formatters } from '../../lib/format.ts';
import { linkProps, openInGitHubDesktop, openUrl, safeHref } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { Badge } from '../../ui/Badge.tsx';
import { IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../../ui/Menu.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { toast } from '../../ui/toast.ts';
import type { WidgetProps } from '../types.ts';
import type { GitHubConfig } from './index.ts';
import { boardCounts, checkLabel, cloneAddress, repoName, repoUrl, visibleRepos, type RepoPage, type RepoSort } from './model.ts';
import styles from './GitHub.module.css';

/** GitHub repositories in Settings → Accounts: its connect dialog, or its Manage dialog once connected. */
export const SETTINGS_ROUTE = '#/settings/accounts?focus=github-status';

const SORT_OPTIONS: readonly { value: RepoSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'pushed', label: 'Last push' },
  { value: 'name', label: 'Name' },
];

/** Shown (without asking for repositories) while the persisted token status says GitHub is not connected. */
const NOT_CONNECTED = new ApiError(409, 'not_configured', 'Add a read-only GitHub token to see your repositories here.');

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function GitHubWidget({ config, setConfig, size }: WidgetProps<GitHubConfig>) {
  const token = useGitHubToken();
  // Known not to be connected: no request (it could only answer 409), no skeleton.
  const notConnected = token.data?.configured === false;
  const board = useGitHubBoard(!notConnected);
  const compact = size.h <= 3 || size.w <= 3;
  const repos = useMemo(() => (board.data ? visibleRepos(board.data.repos, config) : []), [board.data, config]);

  if (notConnected) {
    return (
      <div className={styles.root}>
        <BoardError error={NOT_CONNECTED} onRetry={() => void token.refetch()} compact={compact} />
      </div>
    );
  }

  // Setup problems can't fix themselves: show them instead of a stale list.
  const blocked = board.isError && (isApiError(board.error, 'not_configured') || isApiError(board.error, 'reauth_required'));

  if (board.data === undefined || blocked) {
    return (
      <div className={styles.root}>
        {board.isError ? (
          <BoardError error={board.error} onRetry={() => void board.refetch()} compact={compact} />
        ) : (
          <SkeletonList rows={Math.max(1, Math.min(5, size.h - 2))} />
        )}
      </div>
    );
  }

  const data = board.data;
  const { failing, running } = boardCounts(repos);
  return (
    <div className={styles.root}>
      <WidgetActions>
        {board.isError ? <StaleIndicator updatedAt={board.dataUpdatedAt} error={board.error} onRetry={() => void board.refetch()} /> : null}
        <Menu>
          <MenuTrigger asChild>
            <IconButton icon={ArrowUpDown} size="sm" tooltip={false} aria-label="Sort and board options" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>Sort by</MenuLabel>
            <MenuRadioGroup
              value={config.sort}
              onValueChange={(next) => {
                const option = SORT_OPTIONS.find((o) => o.value === next);
                if (option) void setConfig({ sort: option.value });
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem icon={<RefreshCw aria-hidden="true" />} onSelect={() => void board.refetch()}>
              Refresh
            </MenuItem>
            <MenuItem icon={<ExternalLinkIcon aria-hidden="true" />} onSelect={() => void openUrl(`${GITHUB_WEB_URL}/${data.login}`)}>
              Open GitHub
            </MenuItem>
          </MenuContent>
        </Menu>
      </WidgetActions>
      {compact ? null : (
        <div className={styles.summary}>
          <span className={styles.count}>{plural(repos.length, 'repository', 'repositories')}</span>
          {failing > 0 ? <Badge tone="danger">{failing} failing</Badge> : null}
          {running > 0 ? <Badge tone="warning">{running} running</Badge> : null}
        </div>
      )}
      {repos.length === 0 ? (
        <div className={styles.state}>
          <EmptyState
            icon={FolderSearch}
            compact={compact}
            title="No repositories to show"
            body={data.total > 0 ? 'Archived repositories and forks are hidden. Show them in this widget’s settings.' : undefined}
          />
        </div>
      ) : (
        <ul className={styles.list} aria-label="Repositories">
          {repos.map((repo) => (
            <RepoRow key={repo.fullName} repo={repo} />
          ))}
        </ul>
      )}
      <BoardNotes board={data} repos={repos} compact={compact} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function BoardError({ error, onRetry, compact }: { error: unknown; onRetry(): void; compact: boolean }) {
  // The vault is locked (no account involved): the fix is in Settings → Accounts.
  if (isApiError(error, 'reauth_required') && !error.accountId) {
    const href = safeHref('#/settings/accounts');
    return (
      <div className={styles.state}>
        <EmptyState
          icon={KeyRound}
          compact={compact}
          title="Saved credentials are locked"
          body="Portly can't unlock its stored credentials. Reset them in Settings → Accounts, then add your GitHub token again."
          action={
            href ? (
              <a className={styles.cta} href={href}>
                <KeyRound aria-hidden="true" />
                Open settings
              </a>
            ) : undefined
          }
        />
      </div>
    );
  }
  let title: string | undefined;
  if (isApiError(error, 'not_configured')) {
    const { reason } = (error.details ?? {}) as { reason?: unknown };
    title = reason === 'token_rejected' ? 'GitHub token rejected' : reason === 'insufficient_scope' ? 'GitHub token needs more access' : 'Connect GitHub';
  }
  return (
    <div className={styles.state}>
      <ErrorState error={error} onRetry={onRetry} setupHref={SETTINGS_ROUTE} setupLabel="Set up GitHub" title={title} compact={compact} />
    </div>
  );
}

/** What the rows can't say: results this token can't read, and repositories left out. */
function BoardNotes({ board, repos, compact }: { board: GitHubBoard; repos: readonly GitHubRepo[]; compact: boolean }) {
  if (compact) return null;
  const notes: string[] = [];
  if (repos.some((repo) => repo.checks === 'unavailable')) notes.push('This token can’t read some CI results, so they show as unknown.');
  if (board.truncated) notes.push(`Showing the ${board.repos.length} most recently pushed of ${board.total} repositories.`);
  if (board.skipped > 0) notes.push(`${plural(board.skipped, 'repository', 'repositories')} could not be read.`);
  return notes.length === 0 ? null : <p className={styles.note}>{notes.join(' ')}</p>;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function RepoRow({ repo }: { repo: GitHubRepo }) {
  const fmt = useFormatters();
  const now = useNow(60_000);
  const link = linkProps(repoUrl(repo.fullName));
  const name = repoName(repo.fullName);
  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <span className={styles.dot} data-state={repo.checks} role="img" aria-label={checkLabel(repo.checks)} title={checkLabel(repo.checks)} />
        <div className={styles.main}>
          <div className={styles.heading}>
            {link ? (
              <a {...link} className={styles.name} title={repo.fullName}>
                {name}
                <span className="hb-visually-hidden"> (open on GitHub)</span>
              </a>
            ) : (
              <span className={styles.name}>{name}</span>
            )}
            {repo.isPrivate ? <Marker icon={Lock} label="Private" /> : null}
            {repo.isFork ? <Marker icon={GitFork} label="Fork" /> : null}
            {repo.isArchived ? <Marker icon={Archive} label="Archived" /> : null}
          </div>
          <RepoMeta repo={repo} now={now} fmt={fmt} />
        </div>
        <RepoMenu repo={repo} name={name} />
      </div>
    </li>
  );
}

function Marker({ icon: Icon, label }: { icon: typeof Lock; label: string }) {
  return (
    <span className={styles.marker} title={label}>
      <Icon aria-hidden="true" />
      <span className="hb-visually-hidden">{label}</span>
    </span>
  );
}

function RepoMeta({ repo, now, fmt }: { repo: GitHubRepo; now: Date; fmt: Formatters }) {
  return (
    <div className={styles.meta}>
      {repo.openPullRequests > 0 ? (
        <span className={styles.chip} title={plural(repo.openPullRequests, 'open pull request', 'open pull requests')}>
          <GitPullRequest aria-hidden="true" />
          {repo.openPullRequests}
          <span className="hb-visually-hidden"> open pull requests</span>
        </span>
      ) : null}
      {repo.openIssues > 0 ? (
        <span className={styles.chip} title={plural(repo.openIssues, 'open issue', 'open issues')}>
          <CircleDot aria-hidden="true" />
          {repo.openIssues}
          <span className="hb-visually-hidden"> open issues</span>
        </span>
      ) : null}
      {repo.latestRelease ? (
        <span className={`${styles.chip} ${styles.release}`} title={`Latest release ${repo.latestRelease.tag}`}>
          <Tag aria-hidden="true" />
          <span className={styles.chipText}>{repo.latestRelease.tag}</span>
        </span>
      ) : null}
      {repo.pushedAt !== null ? <span className={styles.pushed}>{fmt.relative(repo.pushedAt, now)}</span> : null}
    </div>
  );
}

/** The row's small operations button. */
function RepoMenu({ repo, name }: { repo: GitHubRepo; name: string }) {
  const open = (page?: RepoPage) => void openUrl(repoUrl(repo.fullName, page));
  const copyClone = async () => {
    const address = cloneAddress(repo.fullName);
    if (address !== null && (await copyText(address))) toast.success('Clone address copied.');
    else toast.error('The clone address could not be copied.');
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={Ellipsis} size="sm" tooltip={false} aria-label={`Actions for ${name}`} />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<Monitor aria-hidden="true" />} onSelect={() => void openInGitHubDesktop(repo.fullName)}>
          Open in GitHub Desktop
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<ExternalLinkIcon aria-hidden="true" />} onSelect={() => open()}>
          Repository
        </MenuItem>
        <MenuItem icon={<Play aria-hidden="true" />} onSelect={() => open('actions')}>
          Actions
        </MenuItem>
        <MenuItem icon={<GitPullRequest aria-hidden="true" />} hint={repo.openPullRequests > 0 ? repo.openPullRequests : undefined} onSelect={() => open('pulls')}>
          Pull requests
        </MenuItem>
        <MenuItem icon={<CircleDot aria-hidden="true" />} hint={repo.openIssues > 0 ? repo.openIssues : undefined} onSelect={() => open('issues')}>
          Issues
        </MenuItem>
        <MenuItem icon={<Tag aria-hidden="true" />} onSelect={() => open('releases')}>
          Releases
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Copy aria-hidden="true" />} onSelect={() => void copyClone()}>
          Copy clone address
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
