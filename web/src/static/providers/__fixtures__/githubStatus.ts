/**
 * GitHub status board test fixtures (copied from server/src/modules/github/__fixtures__/github.ts,
 * pure builders only): GraphQL answers with fictional repositories.
 */

/** Plausible fine-grained tokens, never real ones. */
export const TOKEN = `github_pat_11TESTTOKEN0_${'a'.repeat(40)}`;
export const OTHER_TOKEN = `github_pat_11TESTTOKEN1_${'b'.repeat(40)}`;
export const CLASSIC_TOKEN = `ghp_${'c'.repeat(36)}`;

export const GRAPHQL = 'https://api.github.com/graphql';

export function upstreamRepo(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nameWithOwner: `octo-tester/${name}`,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    pushedAt: '2026-10-30T12:00:00Z',
    issues: { totalCount: 0 },
    pullRequests: { totalCount: 0 },
    latestRelease: null,
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'SUCCESS' } } },
    ...overrides,
  };
}

export function boardAnswer(nodes: unknown[], extra: { errors?: unknown[]; total?: number; hasNextPage?: boolean; endCursor?: string | null } = {}): unknown {
  return {
    data: {
      viewer: {
        login: 'octo-tester',
        repositories: { totalCount: extra.total ?? nodes.length, pageInfo: { hasNextPage: extra.hasNextPage ?? false, endCursor: extra.endCursor ?? null }, nodes },
      },
    },
    ...(extra.errors ? { errors: extra.errors } : {}),
  };
}
