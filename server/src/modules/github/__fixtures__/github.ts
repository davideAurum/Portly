/**
 * GitHub status board test fixtures: GraphQL answers in the shape GitHub gives, with fictional
 * repositories, and a testbed that mounts only the github module.
 */
import fs from 'node:fs';
import { createApp } from '../../../app.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../../testing/test-context.ts';
import { testRequest, type TestRequestOptions } from '../../../testing/test-request.ts';
import * as github from '../index.ts';

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

export interface GitHubTestbed {
  ctx: TestContext;
  json<T = unknown>(method: string, path: string, options?: TestRequestOptions): Promise<{ status: number; body: T; res: Response; text: string }>;
  close(): void;
}

export function githubTestbed(overrides: TestContextOverrides = {}): GitHubTestbed {
  const ctx = createTestContext(overrides);
  const { app } = createApp(ctx, { modules: [{ name: 'github', prefixes: github.prefixes, register: github.register }], webDist: null });
  return {
    ctx,
    async json<T>(method: string, path: string, options?: TestRequestOptions) {
      const res = await testRequest(app, method, path, options);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, res, text };
    },
    close() {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}
