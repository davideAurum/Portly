/**
 * What the GitHub widget shows, as plain functions (§10.8 GitHub): which repositories, in which
 * order, and the addresses of each one's pages. Addresses are built only from a validated
 * `owner/name`, never taken from GitHub's answer.
 */
import { GITHUB_WEB_URL, parseGitHubRepoName, type GitHubCheckState, type GitHubRepo } from '@portly/shared';
import type { GitHubConfig } from './index.ts';

export type RepoSort = GitHubConfig['sort'];

/** The pages of a repository the row's menu opens. */
export type RepoPage = 'actions' | 'pulls' | 'issues' | 'releases';

function pushedTime(repo: GitHubRepo): number {
  const time = repo.pushedAt === null ? Number.NaN : Date.parse(repo.pushedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Most recently pushed first; never pushed last. */
function byPushed(a: GitHubRepo, b: GitHubRepo): number {
  return pushedTime(b) - pushedTime(a);
}

function byName(a: GitHubRepo, b: GitHubRepo): number {
  return repoName(a.fullName).localeCompare(repoName(b.fullName), undefined, { sensitivity: 'base' });
}

const ATTENTION: Readonly<Record<GitHubCheckState, number>> = Object.freeze({ failure: 0, pending: 1, success: 2, none: 2, unavailable: 2 });

const SORTS: Readonly<Record<RepoSort, (a: GitHubRepo, b: GitHubRepo) => number>> = Object.freeze({
  attention: (a, b) => ATTENTION[a.checks] - ATTENTION[b.checks] || byPushed(a, b) || byName(a, b),
  pushed: (a, b) => byPushed(a, b) || byName(a, b),
  name: byName,
});

/** The repositories this widget shows, in its order. */
export function visibleRepos(repos: readonly GitHubRepo[], config: Pick<GitHubConfig, 'sort' | 'showArchived' | 'showForks'>): GitHubRepo[] {
  return repos.filter((repo) => (config.showArchived || !repo.isArchived) && (config.showForks || !repo.isFork)).sort(SORTS[config.sort]);
}

export function boardCounts(repos: readonly GitHubRepo[]): { failing: number; running: number } {
  return {
    failing: repos.filter((repo) => repo.checks === 'failure').length,
    running: repos.filter((repo) => repo.checks === 'pending').length,
  };
}

/** The name without its owner: a board shows one account. */
export function repoName(fullName: string): string {
  return parseGitHubRepoName(fullName)?.name ?? fullName;
}

/** A repository's page on GitHub, or null for a name that is not a repository's. */
export function repoUrl(fullName: string, page?: RepoPage): string | null {
  const repo = parseGitHubRepoName(fullName);
  if (repo === null) return null;
  const base = `${GITHUB_WEB_URL}/${repo.owner}/${repo.name}`;
  return page === undefined ? base : `${base}/${page}`;
}

/** The address `git clone` takes. */
export function cloneAddress(fullName: string): string | null {
  const url = repoUrl(fullName);
  return url === null ? null : `${url}.git`;
}

/** The status dot, in words. */
export function checkLabel(state: GitHubCheckState): string {
  switch (state) {
    case 'success':
      return 'CI passing';
    case 'failure':
      return 'CI failing';
    case 'pending':
      return 'CI running';
    case 'none':
      return 'No CI checks';
    case 'unavailable':
      return 'CI result not available';
  }
}
