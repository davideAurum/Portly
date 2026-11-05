/**
 * GitHub status board contracts (§7a github.ts, §8 GitHub): what the widget shows about each
 * repository, and the pure parts of asking GitHub for it. Both backends use these, so the server
 * and the browser can't drift: the GraphQL query, the reading of its answer, the rate-limit rules
 * and the token's shape.
 *
 * **The answer is hostile input.** Every field is checked and capped, and a repository name must
 * be a valid `owner/name` before it is kept, because the web app builds addresses from it.
 *
 * **Partial answers.** GraphQL answers 200 with `errors` beside whatever it could read, and a
 * field that fails nulls its nearest nullable parent. `issues` and `pullRequests` are non-null, so
 * a token without those permissions loses the whole repository; `defaultBranchRef` is nullable, so
 * a token that can't read it keeps the repository and loses only the CI result. That is why
 * `unavailable` differs from `none`: fine-grained tokens can't use the Checks API (GitHub's own
 * list of what they can't do), and a CI result Portly may not read must never look like "this
 * repository has no CI".
 */
import { z } from 'zod';

export const GITHUB_HOST = 'api.github.com';
export const GITHUB_GRAPHQL_URL = `https://${GITHUB_HOST}/graphql`;
export const GITHUB_WEB_URL = 'https://github.com';

/** GitHub's cap on one page of a connection. */
export const GITHUB_REPOS_PER_PAGE = 100;
/** Repositories read for the board (five pages, so five rate-limit points at most). */
export const GITHUB_MAX_REPOS = 500;

const OWNER_REGEX = /^[A-Za-z0-9-]{1,39}$/;
const REPO_NAME_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const FINE_GRAINED_TOKEN_REGEX = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const CLASSIC_TOKEN_REGEX = /^(?:ghp_|gho_|ghu_|ghs_|[0-9a-f]{40}$)/;

/** `owner/name`, or null unless both parts are valid GitHub names. */
export function parseGitHubRepoName(fullName: string): { owner: string; name: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2) return null;
  const [owner = '', name = ''] = parts;
  if (!OWNER_REGEX.test(owner) || !REPO_NAME_REGEX.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** `GET /api/github/token` → `{configured}` (the token itself is never returned). */
export interface GitHubTokenStatus {
  configured: boolean;
}

/** `PUT /api/github/token {token}` (checked with GitHub before it is stored). */
export const GitHubTokenUpdateSchema = z
  .object({
    token: z.string().trim().min(1).max(300),
  })
  .strict();
export type GitHubTokenUpdate = z.output<typeof GitHubTokenUpdateSchema>;

/** Drops surrounding spaces and a pasted `Bearer ` or `token ` prefix. */
export function cleanGitHubToken(raw: string): string {
  return raw.trim().replace(/^(?:bearer|token)\s+/i, '');
}

/**
 * Why this text can't be saved as the board's token, or null when its shape is right. Classic
 * tokens are refused: the only classic scope that reaches private repositories can also change
 * every one of them, and the board needs to read only.
 */
export function gitHubTokenProblem(token: string): string | null {
  if (CLASSIC_TOKEN_REGEX.test(token)) return 'Classic tokens can also change every repository of your account. Create a read-only fine-grained token instead.';
  if (!FINE_GRAINED_TOKEN_REGEX.test(token)) return "That doesn't look like a GitHub fine-grained token. It starts with github_pat_ and has no spaces.";
  return null;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * The combined CI result of a repository's latest commit on its default branch. `none`: GitHub
 * says it has no checks. `unavailable`: Portly may not read it with this token.
 */
export const GITHUB_CHECK_STATES = ['success', 'failure', 'pending', 'none', 'unavailable'] as const;
export type GitHubCheckState = (typeof GITHUB_CHECK_STATES)[number];

export interface GitHubRelease {
  tag: string;
  publishedAt: string | null;
}

export interface GitHubRepo {
  /** `owner/name`, validated with {@link parseGitHubRepoName}. */
  fullName: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string | null;
  defaultBranch: string | null;
  openIssues: number;
  openPullRequests: number;
  checks: GitHubCheckState;
  latestRelease: GitHubRelease | null;
}

/** `GET /api/github/repos`: the account's own repositories, most recently pushed first. */
export interface GitHubBoard {
  login: string;
  repos: GitHubRepo[];
  /** How many repositories GitHub says the token can see. */
  total: number;
  /** More exist than {@link GITHUB_MAX_REPOS}: the least recently pushed are left out. */
  truncated: boolean;
  /** Repositories GitHub listed but Portly could not read. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Asking GitHub
// ---------------------------------------------------------------------------

/** One page of the account's repositories. `$first` is at most {@link GITHUB_REPOS_PER_PAGE}. */
export const GITHUB_BOARD_QUERY = `query PortlyRepositories($first: Int!, $after: String) {
  viewer {
    login
    repositories(first: $first, after: $after, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        isPrivate
        isArchived
        isFork
        pushedAt
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
        latestRelease { tagName publishedAt }
        defaultBranchRef {
          name
          target { ... on Commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

export interface GitHubBoardVariables {
  first: number;
  after: string | null;
}

/** The JSON body of a request for one page. */
export function gitHubBoardRequest(variables: GitHubBoardVariables): string {
  return JSON.stringify({ query: GITHUB_BOARD_QUERY, variables });
}

const Count = z.object({ totalCount: z.number().int().nonnegative() });

const RepoNodeSchema = z.object({
  nameWithOwner: z.string().max(140),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  isFork: z.boolean(),
  pushedAt: z.string().max(40).nullable(),
  issues: Count,
  pullRequests: Count,
  latestRelease: z
    .object({ tagName: z.string(), publishedAt: z.string().max(40).nullable() })
    .nullable()
    .catch(null),
  defaultBranchRef: z
    .object({
      name: z.string().max(255),
      target: z.object({ statusCheckRollup: z.object({ state: z.string().max(40) }).nullish() }).nullable(),
    })
    .nullable()
    .catch(null),
});

const AnswerSchema = z.object({
  data: z
    .object({
      viewer: z
        .object({
          login: z.string().regex(OWNER_REGEX),
          repositories: z
            .object({
              totalCount: z.number().int().nonnegative(),
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(512).nullable() }),
              nodes: z.array(z.unknown()).nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullish(),
  errors: z
    .array(z.object({ type: z.string().nullish(), message: z.string().nullish(), path: z.array(z.union([z.string(), z.number()])).nullish() }))
    .optional(),
});

/** Which fine-grained permission each field of the query needs, deepest field first. */
const FIELD_PERMISSIONS: readonly (readonly [field: string, permission: string])[] = [
  ['statusCheckRollup', 'Commit statuses'],
  ['defaultBranchRef', 'Contents'],
  ['latestRelease', 'Contents'],
  ['pullRequests', 'Pull requests'],
  ['issues', 'Issues'],
];

const CHECK_STATES: Readonly<Record<string, GitHubCheckState>> = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
});

function isoDate(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

function mapRepo(node: unknown, checksBlocked: boolean): GitHubRepo | null {
  const parsed = RepoNodeSchema.safeParse(node);
  if (!parsed.success || parseGitHubRepoName(parsed.data.nameWithOwner) === null) return null;
  const repo = parsed.data;
  const branch = repo.defaultBranchRef;
  const rollup = branch?.target?.statusCheckRollup ?? null;
  const unknownState = rollup !== null && CHECK_STATES[rollup.state] === undefined;
  return {
    fullName: repo.nameWithOwner,
    isPrivate: repo.isPrivate,
    isArchived: repo.isArchived,
    isFork: repo.isFork,
    pushedAt: isoDate(repo.pushedAt),
    defaultBranch: branch?.name ?? null,
    openIssues: repo.issues.totalCount,
    openPullRequests: repo.pullRequests.totalCount,
    checks: rollup !== null && !unknownState ? (CHECK_STATES[rollup.state] ?? 'none') : checksBlocked || unknownState ? 'unavailable' : 'none',
    latestRelease: repo.latestRelease ? { tag: repo.latestRelease.tagName.slice(0, 100), publishedAt: isoDate(repo.latestRelease.publishedAt) } : null,
  };
}

export interface GitHubBoardPage {
  login: string;
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
  repos: GitHubRepo[];
  skipped: number;
}

export type GitHubPageResult =
  | { ok: true; page: GitHubBoardPage }
  | { ok: false; reason: 'rate_limited' | 'unreadable' }
  | { ok: false; reason: 'permissions'; permissions: string[] };

const pathOf = (path: readonly (string | number)[] | null | undefined): readonly (string | number)[] => path ?? [];

/**
 * Reads one page's answer. A failed field costs only what it reaches: `permissions` is reported
 * only when no repository could be read at all, so one unreadable repository never empties the
 * board. GitHub's error text is only matched, never passed on.
 */
export function readGitHubBoardPage(answer: unknown): GitHubPageResult {
  const parsed = AnswerSchema.safeParse(answer);
  if (!parsed.success) return { ok: false, reason: 'unreadable' };
  const errors = parsed.data.errors ?? [];
  const rateLimited = errors.some((e) => e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message ?? ''));
  const forbidden = errors.filter((e) => e.type === 'FORBIDDEN' || e.type === 'INSUFFICIENT_SCOPES' || /not accessible/i.test(e.message ?? ''));
  const permissions = [
    ...new Set(forbidden.flatMap((e) => FIELD_PERMISSIONS.filter(([field]) => pathOf(e.path).includes(field)).map(([, permission]) => permission).slice(0, 1))),
  ];
  // A failed `defaultBranchRef` or anything under it leaves that repository's CI result unknown.
  const checksBlocked = new Set(errors.flatMap((e) => (pathOf(e.path).includes('defaultBranchRef') ? [pathOf(e.path)[3]] : [])));

  const viewer = parsed.data.data?.viewer ?? null;
  const repositories = viewer?.repositories ?? null;
  if (viewer === null || repositories === null) {
    if (rateLimited) return { ok: false, reason: 'rate_limited' };
    return forbidden.length > 0 ? { ok: false, reason: 'permissions', permissions } : { ok: false, reason: 'unreadable' };
  }
  const nodes = repositories.nodes ?? [];
  const repos = nodes.flatMap((node, index) => mapRepo(node, checksBlocked.has(index)) ?? []);
  if (repos.length === 0 && nodes.length > 0) {
    if (rateLimited) return { ok: false, reason: 'rate_limited' };
    return forbidden.length > 0 ? { ok: false, reason: 'permissions', permissions } : { ok: false, reason: 'unreadable' };
  }
  return {
    ok: true,
    page: {
      login: viewer.login,
      total: repositories.totalCount,
      hasNextPage: repositories.pageInfo.hasNextPage,
      endCursor: repositories.pageInfo.endCursor,
      repos,
      skipped: nodes.length - repos.length,
    },
  };
}

export type GitHubBoardResult = { ok: true; board: GitHubBoard } | Extract<GitHubPageResult, { ok: false }>;

/** Reads pages through `fetchPage` until the list ends or {@link GITHUB_MAX_REPOS} are read. */
export async function collectGitHubBoard(fetchPage: (variables: GitHubBoardVariables) => Promise<GitHubPageResult>): Promise<GitHubBoardResult> {
  const repos: GitHubRepo[] = [];
  let after: string | null = null;
  let skipped = 0;
  for (;;) {
    const result: GitHubPageResult = await fetchPage({ first: GITHUB_REPOS_PER_PAGE, after });
    if (!result.ok) return result;
    const { page } = result;
    repos.push(...page.repos);
    skipped += page.skipped;
    const more = page.hasNextPage && page.endCursor !== null;
    if (!more || repos.length + skipped >= GITHUB_MAX_REPOS) {
      return { ok: true, board: { login: page.login, repos, total: page.total, truncated: more, skipped } };
    }
    after = page.endCursor;
  }
}

/**
 * A refused request's rate-limit signs. Primary limits can also arrive as a 200 with `errors`
 * ({@link readGitHubBoardPage}); secondary ones as a 403 with `Retry-After`.
 */
export function isGitHubRateLimit(status: number, headers: { get(name: string): string | null }, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && (headers.get('x-ratelimit-remaining')?.trim() === '0' || headers.get('retry-after') !== null || /rate limit/i.test(body));
}

/** Cooldown when an answer says nothing usable. */
export const GITHUB_DEFAULT_RETRY_AFTER_S = 60;
export const GITHUB_MAX_RETRY_AFTER_S = 60 * 60;

/** Seconds to wait, from `Retry-After` or, with no requests left, `X-RateLimit-Reset`. */
export function gitHubRetryAfterSeconds(headers: { get(name: string): string | null }, nowMs: number): number {
  const retry = headers.get('retry-after')?.trim();
  const reset = headers.get('x-ratelimit-reset')?.trim();
  let seconds: number | null = null;
  if (retry !== undefined && /^\d+$/.test(retry)) seconds = Number(retry);
  else if (headers.get('x-ratelimit-remaining')?.trim() === '0' && reset !== undefined && /^\d+$/.test(reset)) seconds = Math.ceil(Number(reset) - nowMs / 1000);
  if (seconds === null || !Number.isFinite(seconds)) seconds = GITHUB_DEFAULT_RETRY_AFTER_S;
  return Math.min(GITHUB_MAX_RETRY_AFTER_S, Math.max(1, seconds));
}

/** "Issues and Pull requests", for messages. */
function listPermissions(permissions: readonly string[]): string {
  if (permissions.length === 0) return 'your repositories';
  if (permissions.length === 1) return permissions[0] ?? '';
  return `${permissions.slice(0, -1).join(', ')} and ${permissions.at(-1) ?? ''}`;
}

/** What to tell the user when the token may not read what the board asks for. */
export function gitHubPermissionsMessage(permissions: readonly string[]): string {
  return `GitHub accepted the token, but it may not read ${listPermissions(permissions)}. Give it read-only access in GitHub's token settings, or create a new one.`;
}

/** What to tell the user when the token can't see a single repository. */
export const GITHUB_NO_REPOS_MESSAGE = "GitHub accepted the token, but it can't see any repositories. Create it with Repository access set to All repositories.";
