import { describe, expect, it } from 'vitest';
import { GITHUB_CHECK_STATES, type GitHubRepo } from '@portly/shared';
import { boardCounts, checkLabel, cloneAddress, repoName, repoUrl, visibleRepos } from './model.ts';

function repo(name: string, extra: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    fullName: `octo-tester/${name}`,
    isPrivate: false,
    isArchived: false,
    isFork: false,
    pushedAt: '2026-10-30T12:00:00Z',
    defaultBranch: 'main',
    openIssues: 0,
    openPullRequests: 0,
    checks: 'none',
    latestRelease: null,
    ...extra,
  };
}

const names = (repos: readonly GitHubRepo[]) => repos.map((r) => repoName(r.fullName));
const defaults = { sort: 'attention', showArchived: false, showForks: false } as const;

describe('visibleRepos', () => {
  it('puts failing first, then running, then the most recently pushed', () => {
    const repos = [
      repo('quiet', { pushedAt: '2026-10-01T00:00:00Z', checks: 'none' }),
      repo('passing', { pushedAt: '2026-11-01T00:00:00Z', checks: 'success' }),
      repo('running', { pushedAt: '2026-09-01T00:00:00Z', checks: 'pending' }),
      repo('broken', { pushedAt: '2026-08-01T00:00:00Z', checks: 'failure' }),
      repo('unknown', { pushedAt: '2026-10-15T00:00:00Z', checks: 'unavailable' }),
    ];
    expect(names(visibleRepos(repos, defaults))).toEqual(['broken', 'running', 'passing', 'unknown', 'quiet']);
  });

  it('sorts by last push, with never-pushed repositories last', () => {
    const repos = [repo('empty', { pushedAt: null }), repo('older', { pushedAt: '2026-01-01T00:00:00Z' }), repo('newer', { pushedAt: '2026-06-01T00:00:00Z', checks: 'failure' })];
    expect(names(visibleRepos(repos, { ...defaults, sort: 'pushed' }))).toEqual(['newer', 'older', 'empty']);
  });

  it('sorts by name, ignoring case', () => {
    expect(names(visibleRepos([repo('beta'), repo('Alpha'), repo('gamma')], { ...defaults, sort: 'name' }))).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('hides archived repositories and forks unless asked', () => {
    const repos = [repo('kept'), repo('old', { isArchived: true }), repo('borrowed', { isFork: true })];
    expect(names(visibleRepos(repos, defaults))).toEqual(['kept']);
    expect(names(visibleRepos(repos, { ...defaults, showArchived: true, sort: 'name' }))).toEqual(['kept', 'old']);
    expect(names(visibleRepos(repos, { ...defaults, showForks: true, sort: 'name' }))).toEqual(['borrowed', 'kept']);
  });

  it('leaves the list it was given alone', () => {
    const repos = [repo('b'), repo('a')];
    visibleRepos(repos, { ...defaults, sort: 'name' });
    expect(names(repos)).toEqual(['b', 'a']);
  });
});

describe('boardCounts', () => {
  it('counts what needs a look', () => {
    expect(boardCounts([repo('a', { checks: 'failure' }), repo('b', { checks: 'failure' }), repo('c', { checks: 'pending' }), repo('d', { checks: 'success' })])).toEqual({ failing: 2, running: 1 });
  });
});

describe('addresses', () => {
  it('builds them from the repository name', () => {
    expect(repoUrl('octo-tester/sample')).toBe('https://github.com/octo-tester/sample');
    expect(repoUrl('octo-tester/sample', 'actions')).toBe('https://github.com/octo-tester/sample/actions');
    expect(repoUrl('octo-tester/sample', 'pulls')).toBe('https://github.com/octo-tester/sample/pulls');
    expect(cloneAddress('octo-tester/sample')).toBe('https://github.com/octo-tester/sample.git');
  });

  it('builds none from a name that is not a repository', () => {
    for (const bad of ['javascript:alert(1)', 'a/b/c', 'octo/..', '../..']) {
      expect(repoUrl(bad), bad).toBeNull();
      expect(cloneAddress(bad), bad).toBeNull();
    }
  });
});

describe('checkLabel', () => {
  it('tells "no checks" from "can\'t tell" in words', () => {
    expect(checkLabel('none')).toBe('No CI checks');
    expect(checkLabel('unavailable')).toBe('CI result not available');
    expect(new Set(GITHUB_CHECK_STATES.map(checkLabel)).size).toBe(GITHUB_CHECK_STATES.length);
  });
});
