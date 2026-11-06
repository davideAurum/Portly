import { describe, expect, it } from 'vitest';
import {
  GITHUB_MAX_REPOS,
  GITHUB_REPOS_PER_PAGE,
  cleanGitHubToken,
  collectGitHubBoard,
  gitHubBoardRequest,
  gitHubPermissionsMessage,
  gitHubRetryAfterSeconds,
  gitHubTokenProblem,
  isGitHubRateLimit,
  parseGitHubRepoName,
  readGitHubBoardPage,
  type GitHubPageResult,
} from './github.ts';

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nameWithOwner: 'octo-tester/sample',
    isPrivate: false,
    isArchived: false,
    isFork: false,
    pushedAt: '2026-10-30T12:00:00Z',
    issues: { totalCount: 2 },
    pullRequests: { totalCount: 1 },
    latestRelease: { tagName: 'v1.2.0', publishedAt: '2026-10-01T09:00:00Z' },
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'SUCCESS' } } },
    ...overrides,
  };
}

function answer(nodes: unknown[], extra: { errors?: unknown[]; total?: number; hasNextPage?: boolean; endCursor?: string | null } = {}): unknown {
  return {
    data: {
      viewer: {
        login: 'octo-tester',
        repositories: {
          totalCount: extra.total ?? nodes.length,
          pageInfo: { hasNextPage: extra.hasNextPage ?? false, endCursor: extra.endCursor ?? null },
          nodes,
        },
      },
    },
    ...(extra.errors ? { errors: extra.errors } : {}),
  };
}

const forbidden = (path: (string | number)[]) => ({ type: 'FORBIDDEN', path, message: 'Resource not accessible by personal access token' });

function page(result: GitHubPageResult) {
  if (!result.ok) throw new Error(`Expected a page, got ${result.reason}`);
  return result.page;
}

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

describe('repository names', () => {
  it('accepts owner/name and refuses anything that could change an address', () => {
    expect(parseGitHubRepoName('octo-tester/portly.site_2')).toEqual({ owner: 'octo-tester', name: 'portly.site_2' });
    for (const bad of ['octo-tester', 'a/b/c', 'octo tester/x', 'octo/..', 'octo/.', '/x', 'x/', 'octo/x?y=1', 'octo/x#y', '..%2f/x', `${'a'.repeat(40)}/x`, `a/${'b'.repeat(101)}`]) {
      expect(parseGitHubRepoName(bad), bad).toBeNull();
    }
  });
});

describe('the token', () => {
  it('drops surrounding spaces and a pasted prefix', () => {
    expect(cleanGitHubToken('  Bearer github_pat_abc \n')).toBe('github_pat_abc');
    expect(cleanGitHubToken('token github_pat_abc')).toBe('github_pat_abc');
  });

  it('takes fine-grained tokens only', () => {
    expect(gitHubTokenProblem(`github_pat_${'a'.repeat(30)}`)).toBeNull();
    for (const classic of [`ghp_${'a'.repeat(36)}`, `gho_${'a'.repeat(36)}`, 'a'.repeat(40).replace(/a/g, 'f')]) {
      expect(gitHubTokenProblem(classic), classic).toMatch(/^Classic tokens/);
    }
    for (const nonsense of ['short', 'github_pat_', 'github_pat_has spaces in it 0123456789', 'https://github.com/settings/tokens']) {
      expect(gitHubTokenProblem(nonsense), nonsense).toMatch(/fine-grained token/);
    }
  });
});

describe('the request', () => {
  it('sends the variables beside the query', () => {
    const body = JSON.parse(gitHubBoardRequest({ first: 100, after: 'abc' })) as { query: string; variables: unknown };
    expect(body.variables).toEqual({ first: 100, after: 'abc' });
    expect(body.query).toContain('ownerAffiliations: [OWNER]');
    expect(body.query).toContain('statusCheckRollup');
  });
});

describe('reading an answer', () => {
  it('maps a repository', () => {
    const { repos, login, total } = page(readGitHubBoardPage(answer([node({ isPrivate: true })])));
    expect(login).toBe('octo-tester');
    expect(total).toBe(1);
    expect(repos).toEqual([
      {
        fullName: 'octo-tester/sample',
        isPrivate: true,
        isArchived: false,
        isFork: false,
        pushedAt: '2026-10-30T12:00:00Z',
        defaultBranch: 'main',
        openIssues: 2,
        openPullRequests: 1,
        checks: 'success',
        latestRelease: { tag: 'v1.2.0', publishedAt: '2026-10-01T09:00:00Z' },
      },
    ]);
  });

  it.each([
    ['SUCCESS', 'success'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
  ])('reads a rollup of %s as %s', (state, checks) => {
    const nodes = [node({ defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state } } } })];
    expect(page(readGitHubBoardPage(answer(nodes))).repos[0]?.checks).toBe(checks);
  });

  it('says none when GitHub says the commit has no checks, and for an empty repository', () => {
    const nodes = [node({ defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } } }), node({ defaultBranchRef: null })];
    const { repos } = page(readGitHubBoardPage(answer(nodes)));
    expect(repos.map((r) => r.checks)).toEqual(['none', 'none']);
    expect(repos[1]?.defaultBranch).toBeNull();
  });

  it('never calls a result it may not read "none"', () => {
    const nodes = [
      node({ defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } } }),
      node({ nameWithOwner: 'octo-tester/other', defaultBranchRef: { name: 'main', target: { statusCheckRollup: null } } }),
    ];
    const errors = [forbidden(['viewer', 'repositories', 'nodes', 0, 'defaultBranchRef', 'target', 'statusCheckRollup'])];
    const { repos } = page(readGitHubBoardPage(answer(nodes, { errors })));
    expect(repos.map((r) => r.checks)).toEqual(['unavailable', 'none']);
  });

  it('keeps a repository whose branch can\'t be read, with its CI result unknown', () => {
    const errors = [forbidden(['viewer', 'repositories', 'nodes', 0, 'defaultBranchRef'])];
    const { repos } = page(readGitHubBoardPage(answer([node({ defaultBranchRef: null })], { errors })));
    expect(repos[0]).toMatchObject({ checks: 'unavailable', defaultBranch: null, openIssues: 2 });
  });

  it('treats a CI state it does not know as unknown, not as passing or absent', () => {
    const nodes = [node({ defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'SOMETHING_NEW' } } } })];
    expect(page(readGitHubBoardPage(answer(nodes))).repos[0]?.checks).toBe('unavailable');
  });

  it('names the permissions when no repository could be read', () => {
    const errors = [forbidden(['viewer', 'repositories', 'nodes', 0, 'issues']), forbidden(['viewer', 'repositories', 'nodes', 0, 'pullRequests'])];
    expect(readGitHubBoardPage(answer([null], { errors }))).toEqual({ ok: false, reason: 'permissions', permissions: ['Issues', 'Pull requests'] });
  });

  it('one unreadable repository does not empty the board', () => {
    const errors = [forbidden(['viewer', 'repositories', 'nodes', 0, 'issues'])];
    const result = page(readGitHubBoardPage(answer([null, node()], { errors })));
    expect(result.repos).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('drops a repository with a name that could change an address', () => {
    const result = page(readGitHubBoardPage(answer([node({ nameWithOwner: 'octo/../evil' }), node()])));
    expect(result.repos.map((r) => r.fullName)).toEqual(['octo-tester/sample']);
    expect(result.skipped).toBe(1);
  });

  it('survives hostile values', () => {
    const nodes = [node({ pushedAt: 'not a date', latestRelease: { tagName: 'x'.repeat(5000), publishedAt: 'never' } })];
    const repo = page(readGitHubBoardPage(answer(nodes))).repos[0];
    expect(repo?.pushedAt).toBeNull();
    expect(repo?.latestRelease).toEqual({ tag: 'x'.repeat(100), publishedAt: null });
  });

  it('a limit reported in a 200 is a rate limit', () => {
    expect(readGitHubBoardPage({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] })).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('anything else is unreadable, never a crash', () => {
    for (const junk of [null, 'text', 42, {}, { data: null }, { data: { viewer: { login: 7 } } }, { errors: 'nope' }]) {
      expect(readGitHubBoardPage(junk), JSON.stringify(junk)).toEqual({ ok: false, reason: 'unreadable' });
    }
  });

  it('an error entry of an unexpected shape costs nothing', () => {
    const errors = [{ type: null, message: null, path: null }, { locations: [{ line: 1, column: 1 }] }];
    expect(page(readGitHubBoardPage(answer([node()], { errors }))).repos).toHaveLength(1);
  });

  it('refuses a login that could change an address', () => {
    expect(readGitHubBoardPage({ data: { viewer: { login: '../evil', repositories: null } } })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a viewer it may not read at all is a permissions problem', () => {
    expect(readGitHubBoardPage({ data: { viewer: null }, errors: [{ type: 'FORBIDDEN', path: ['viewer'] }] })).toEqual({ ok: false, reason: 'permissions', permissions: [] });
  });
});

describe('collecting pages', () => {
  const pageOf = (count: number, hasNextPage: boolean, endCursor: string | null, total = 250): GitHubPageResult =>
    readGitHubBoardPage(answer(Array.from({ length: count }, (_, i) => node({ nameWithOwner: `octo-tester/r${endCursor ?? 'last'}-${i}` })), { total, hasNextPage, endCursor }));

  it('follows the cursor until the list ends', async () => {
    const asked: (string | null)[] = [];
    const result = await collectGitHubBoard(async ({ first, after }) => {
      expect(first).toBe(GITHUB_REPOS_PER_PAGE);
      asked.push(after);
      return after === null ? pageOf(100, true, 'p2') : after === 'p2' ? pageOf(100, true, 'p3') : pageOf(50, false, null);
    });
    expect(asked).toEqual([null, 'p2', 'p3']);
    expect(result).toMatchObject({ ok: true, board: { login: 'octo-tester', total: 250, truncated: false, skipped: 0 } });
    if (result.ok) expect(result.board.repos).toHaveLength(250);
  });

  it('stops at the cap and says more exist', async () => {
    let n = 0;
    const result = await collectGitHubBoard(async () => {
      n += 1;
      return pageOf(100, true, `p${n}`, 900);
    });
    expect(n).toBe(GITHUB_MAX_REPOS / GITHUB_REPOS_PER_PAGE);
    expect(result).toMatchObject({ ok: true, board: { total: 900, truncated: true } });
    if (result.ok) expect(result.board.repos).toHaveLength(GITHUB_MAX_REPOS);
  });

  it('a page that fails fails the board', async () => {
    const result = await collectGitHubBoard(async ({ after }) => (after === null ? pageOf(100, true, 'p2') : { ok: false, reason: 'unreadable' }));
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('rate limits', () => {
  it('tells a limit from a refusal', () => {
    expect(isGitHubRateLimit(429, headers(), '')).toBe(true);
    expect(isGitHubRateLimit(403, headers({ 'x-ratelimit-remaining': '0' }), '')).toBe(true);
    expect(isGitHubRateLimit(403, headers({ 'retry-after': '30' }), '')).toBe(true);
    expect(isGitHubRateLimit(403, headers(), '{"message":"You have exceeded a secondary rate limit"}')).toBe(true);
    expect(isGitHubRateLimit(403, headers({ 'x-ratelimit-remaining': '4000' }), '{"message":"Forbidden"}')).toBe(false);
    expect(isGitHubRateLimit(200, headers({ 'x-ratelimit-remaining': '0' }), '')).toBe(false);
  });

  it('waits as long as GitHub says, within limits', () => {
    const now = 1_000_000_000;
    expect(gitHubRetryAfterSeconds(headers({ 'retry-after': '120' }), now)).toBe(120);
    expect(gitHubRetryAfterSeconds(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 300) }), now)).toBe(300);
    expect(gitHubRetryAfterSeconds(headers(), now)).toBe(60);
    expect(gitHubRetryAfterSeconds(headers({ 'retry-after': '999999' }), now)).toBe(3600);
    expect(gitHubRetryAfterSeconds(headers({ 'retry-after': '0' }), now)).toBe(1);
    expect(gitHubRetryAfterSeconds(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12' }), now)).toBe(1);
  });
});

describe('messages', () => {
  it('names what is missing', () => {
    expect(gitHubPermissionsMessage(['Issues'])).toContain('may not read Issues.');
    expect(gitHubPermissionsMessage(['Issues', 'Pull requests', 'Contents'])).toContain('may not read Issues, Pull requests and Contents.');
    expect(gitHubPermissionsMessage([])).toContain('may not read your repositories.');
  });
});
