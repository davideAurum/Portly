/**
 * The GitHub repository and token for launch pad sync (docs/design/launchpad-sync-github.md), kept
 * like the Todoist token (`todoistToken.ts`): in the `github-sync` slice, stored as typed (the
 * browser-only build has no vault), never exported and never returned (only `{configured}`).
 *
 * Which token: a fine-grained personal access token whose repository access is only the sync
 * repository, with the repository permission **Contents: Read and write** (Metadata: Read comes with
 * it). Classic tokens are refused: the only classic scope that reaches a private repository, `repo`,
 * reaches every repository of the account, and the token sits unencrypted on an origin every Pages
 * site of the account shares (ARCHITECTURE §4.1). A fine-grained token's permissions can't be read
 * back, so it is checked to see the repository (private) and read its contents; write access shows
 * at the first write.
 */
import type { StaticContext } from '../context.ts';
import { fetchTextCapped, upstreamFailure, type FetchLike } from '../lib/fetch.ts';
import { StaticApiError } from '../respond.ts';
import { SLICE, getGitHubSync } from '../slices.ts';
import { GITHUB_API, MAIN_PATH, createGitHubRepoStore, githubHeaders, parseRepository, statusError, type GitHubRepoStore, type Repository } from './githubRepo.ts';

/** Fine-grained personal access tokens only. */
export const GITHUB_TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const VALIDATE_TIMEOUT_MS = 10_000;
const VALIDATE_MAX_BYTES = 4 * 1024 * 1024;

/** Trims, drops a pasted `Bearer `/`token ` prefix and checks the shape; throws 422 on nonsense. */
export function normalizeGitHubToken(raw: string): string {
  const token = raw.trim().replace(/^(?:bearer|token)\s+/i, '');
  if (/^(?:ghp_|gho_|ghu_|ghs_|[0-9a-f]{40}$)/.test(token)) {
    throw new StaticApiError('validation_failed', 'Classic tokens can reach every repository of your account. Create a fine-grained token limited to the sync repository.', [
      { path: 'token', message: 'Classic token', code: 'invalid_format' },
    ]);
  }
  if (!GITHUB_TOKEN_PATTERN.test(token)) {
    throw new StaticApiError('validation_failed', "That doesn't look like a GitHub fine-grained token. It starts with github_pat_ and has no spaces.", [
      { path: 'token', message: 'Invalid token format', code: 'invalid_format' },
    ]);
  }
  return token;
}

/** `owner/name` with surrounding spaces dropped; throws 422 unless both parts are valid GitHub names. */
export function normalizeRepository(raw: string): Repository {
  const repository = parseRepository(raw.trim());
  if (repository === null) {
    throw new StaticApiError('validation_failed', 'Enter the repository as owner/name, for example octo-user/portly-sync.', [
      { path: 'repository', message: 'Invalid repository', code: 'invalid_format' },
    ]);
  }
  return repository;
}

/** GitHub refused the token or the repository; `field` says which one the form shows it under. */
function rejected(message: string, field: 'token' | 'repository' = 'token'): StaticApiError {
  return new StaticApiError('validation_failed', message, { reason: 'token_rejected', field });
}

async function get(url: string, token: string, signal: AbortSignal | null | undefined, fetch: FetchLike | undefined) {
  try {
    return await fetchTextCapped(
      url,
      { method: 'GET', headers: githubHeaders(token), cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' },
      { timeoutMs: VALIDATE_TIMEOUT_MS, maxBytes: VALIDATE_MAX_BYTES, signal, fetch },
    );
  } catch (err) {
    throw upstreamFailure(err, 'api.github.com');
  }
}

function isRateLimited(res: { status: number; headers: Headers; text: string }): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  let body: unknown = null;
  try {
    body = JSON.parse(res.text) as unknown;
  } catch {
    // Not JSON: classified from the headers alone.
  }
  // The same rate-limit rules as the store (headers, or GitHub's wording of a secondary limit).
  return statusError(res.status, res.headers, body, Date.now()).code === 'rate_limited';
}

const rateLimited = () => new StaticApiError('rate_limited', 'GitHub is limiting requests. Try again in a few minutes.');

/**
 * Checks a new repository and token with GitHub before they are saved: `GET /repos/{owner}/{name}`
 * must find the repository and say it is private, and reading the launch pad file must be allowed
 * (200, or 404 while it does not exist yet).
 */
export async function validateGitHubSync(
  token: string,
  repository: Repository,
  options: { signal?: AbortSignal | null; fetch?: FetchLike } = {},
): Promise<void> {
  const base = `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const repo = await get(base, token, options.signal, options.fetch);
  if (repo.status === 401) throw rejected('GitHub rejected this token. Check that you copied all of it and that it has not expired.');
  if (isRateLimited(repo)) throw rateLimited();
  if (repo.status === 404 || repo.status === 403) {
    throw rejected("GitHub can't find that repository with this token. Check owner/name, and that the token's repository access includes it.", 'repository');
  }
  if (repo.status !== 200) throw new StaticApiError('provider_error', `GitHub returned an unexpected response (HTTP ${repo.status}).`);
  let isPrivate: unknown;
  try {
    isPrivate = (JSON.parse(repo.text) as { private?: unknown }).private;
  } catch {
    isPrivate = undefined;
  }
  if (typeof isPrivate !== 'boolean') throw new StaticApiError('provider_error', 'GitHub returned an answer Portly could not read.');
  if (!isPrivate) throw rejected('This repository is public. Portly syncs only to a private repository: create a private one, or make this one private.', 'repository');

  const contents = await get(`${base}/contents/${MAIN_PATH}`, token, options.signal, options.fetch);
  if (isRateLimited(contents)) throw rateLimited();
  if (contents.status === 403) throw rejected('This token may not read the repository. Give it the Contents permission (Read and write).');
  if (contents.status !== 200 && contents.status !== 404) {
    throw new StaticApiError('provider_error', `GitHub returned an unexpected response (HTTP ${contents.status}).`);
  }
}

/** Whether a store can be opened: the same test as {@link openGitHubStore}. */
export function hasGitHubSync(ctx: StaticContext): boolean {
  const { token, repository } = getGitHubSync(ctx);
  return token !== null && token !== '' && repository !== null && parseRepository(repository) !== null;
}

/**
 * Replaces the repository and token and persists the slice. On a storage failure the previous slice
 * is put back, with the generation still moving forward, and the error propagates (as for the
 * Todoist token).
 */
async function writeSettings(ctx: StaticContext, token: string | null, repository: string | null): Promise<void> {
  const previous = { ...getGitHubSync(ctx) };
  const generation = previous.generation + 1;
  ctx.state.set(SLICE.githubSync, { token, repository, generation });
  try {
    await ctx.state.commit(SLICE.githubSync);
  } catch (err) {
    ctx.state.set(SLICE.githubSync, { ...previous, generation: generation + 1 });
    throw err;
  }
}

export function storeGitHubSync(ctx: StaticContext, token: string, repository: Repository): Promise<void> {
  return writeSettings(ctx, token, `${repository.owner}/${repository.name}`);
}

/** Removes the token and the repository name. The repository stays on GitHub. */
export function clearGitHubSync(ctx: StaticContext): Promise<void> {
  return writeSettings(ctx, null, null);
}

/** A store for the saved repository and token, or null without them. */
export function openGitHubStore(ctx: StaticContext, options: { fetch?: FetchLike } = {}): GitHubRepoStore | null {
  const { token, repository } = getGitHubSync(ctx);
  if (token === null || token === '' || repository === null) return null;
  const parsed = parseRepository(repository);
  if (parsed === null) return null;
  return createGitHubRepoStore({ token, repository: parsed, fetch: options.fetch, now: ctx.now });
}
