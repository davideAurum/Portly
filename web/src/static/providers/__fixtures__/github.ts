/**
 * A small in-memory GitHub for the repository store's tests: one repository with the REST routes
 * the store uses (`GET /repos/{owner}/{repo}`, `GET|PUT|DELETE …/contents/{path}`,
 * `GET …/git/blobs/{sha}`), content-addressed blob shas, 1 MB inline limit, `ETag`/`If-None-Match`,
 * the sha checks of the contents API (422 without a needed sha, 409 with a stale one) and hooks to
 * inject failures or another browser's write. Answers follow the shapes seen from api.github.com
 * on 2026-10-27. The account is fictional.
 */
import { decodeBase64, encodeBase64 } from '../../lib/base64.ts';
import { createFakeFetch, type FakeFetch, type FakeRequest, type FakeResponseSpec } from './fakeFetch.ts';

export const GITHUB_TOKEN = 'github_pat_11TESTTOKEN0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
export const CLASSIC_TOKEN = 'ghp_TestToken0123456789abcdefghijklmnopq';
export const OWNER = 'octo-tester';
export const REPO = 'portly-sync';
export const REPOSITORY = { owner: OWNER, name: REPO } as const;
const API = 'https://api.github.com';
export const REPO_URL = `${API}/repos/${OWNER}/${REPO}`;
/** What the contents API inlines of a file. */
export const INLINE_LIMIT = 1024 * 1024;

export interface FakeCommit {
  path: string;
  message: string;
}

export interface FakeGitHub {
  fake: FakeFetch;
  repo: { exists: boolean; private: boolean };
  /** path → blob sha, on the default branch. */
  files: Map<string, string>;
  commits: FakeCommit[];
  /** Writes a file directly (another browser's write, or by hand); returns its sha. */
  put(path: string, content: string | Uint8Array): string;
  remove(path: string): void;
  sha(path: string): string | undefined;
  text(path: string): string | undefined;
  bytes(path: string): Uint8Array | undefined;
  /** Runs before a PUT or DELETE is applied (to inject a concurrent write); return a spec to answer with it instead. */
  beforeWrite: ((req: FakeRequest) => FakeResponseSpec | void) | null;
  /** Answers every request with this instead, while it returns a spec. */
  override: ((req: FakeRequest) => FakeResponseSpec | null) | null;
  calls(method?: string, pattern?: RegExp): FakeRequest[];
}

const encoder = new TextEncoder();

/** GitHub's base64: a line break every 60 characters, and one at the end. */
export function githubBase64(bytes: Uint8Array): string {
  const plain = encodeBase64(bytes);
  return plain === '' ? '' : `${plain.replace(/.{60}/g, '$&\n')}\n`;
}

export function createFakeGitHub(): FakeGitHub {
  const blobs = new Map<string, Uint8Array>();
  const shaByContent = new Map<string, string>();
  let counter = 0;

  /** Content-addressed like git: the same bytes always get the same sha. */
  function store(bytes: Uint8Array): string {
    const key = encodeBase64(bytes);
    let sha = shaByContent.get(key);
    if (sha === undefined) {
      sha = (++counter).toString(16).padStart(40, '0');
      shaByContent.set(key, sha);
      blobs.set(sha, bytes);
    }
    return sha;
  }

  const notFound = (message = 'Not Found'): FakeResponseSpec => ({ status: 404, json: { message, status: '404' } });

  function fileJson(path: string, sha: string) {
    const bytes = blobs.get(sha)!;
    const inline = bytes.byteLength <= INLINE_LIMIT;
    return {
      name: path.split('/').at(-1),
      path,
      sha,
      size: bytes.byteLength,
      type: 'file',
      content: inline ? githubBase64(bytes) : '',
      encoding: inline ? 'base64' : 'none',
      download_url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${path}?token=SHOULD_NOT_BE_USED`,
    };
  }

  const github: FakeGitHub = {
    fake: createFakeFetch(),
    repo: { exists: true, private: true },
    files: new Map(),
    commits: [],
    put(path, content) {
      const sha = store(typeof content === 'string' ? encoder.encode(content) : content);
      github.files.set(path, sha);
      github.commits.push({ path, message: 'by hand' });
      return sha;
    },
    remove(path) {
      github.files.delete(path);
    },
    sha: (path) => github.files.get(path),
    text(path) {
      const bytes = github.bytes(path);
      return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
    },
    bytes(path) {
      const sha = github.files.get(path);
      return sha === undefined ? undefined : blobs.get(sha);
    },
    beforeWrite: null,
    override: null,
    calls(method, pattern) {
      return github.fake.calls.filter((c) => (method === undefined || c.method === method) && (pattern === undefined || pattern.test(c.url)));
    },
  };

  github.fake.add({
    match: /./,
    respond: (req) => {
      const overridden = github.override?.(req);
      if (overridden) return overridden;
      const url = new URL(req.url);
      const prefix = `/repos/${OWNER}/${REPO}`;
      if (url.origin !== API || !github.repo.exists || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return notFound();
      const rest = url.pathname.slice(prefix.length);
      if (rest === '' && req.method === 'GET') return { json: { id: 1, name: REPO, full_name: `${OWNER}/${REPO}`, private: github.repo.private } };

      const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
      if (blob && req.method === 'GET') {
        const bytes = blobs.get(blob[1]!);
        return bytes ? { json: { sha: blob[1], size: bytes.byteLength, encoding: 'base64', content: githubBase64(bytes) } } : notFound();
      }

      if (!rest.startsWith('/contents/')) return notFound();
      const path = rest.slice('/contents/'.length);
      const current = github.files.get(path);
      if (req.method === 'GET') {
        if (github.files.size === 0) return notFound('This repository is empty.');
        if (current === undefined) {
          const children = [...github.files.keys()].filter((p) => p.startsWith(`${path}/`));
          return children.length > 0 ? { json: children.map((p) => ({ name: p, path: p, type: 'file' })) } : notFound();
        }
        const etag = `"${current}"`;
        if (req.headers.get('if-none-match') === etag) return { status: 304, headers: { etag } };
        return { json: fileJson(path, current), headers: { etag } };
      }

      const injected = github.beforeWrite?.(req);
      if (injected) return injected;
      const after = github.files.get(path);
      const body = JSON.parse(req.body ?? '{}') as { message?: string; content?: string; sha?: string };
      if (req.method === 'PUT') {
        if (after !== undefined && body.sha === undefined) return { status: 422, json: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.', status: '422' } };
        if (after === undefined && body.sha !== undefined) return { status: 422, json: { message: 'Invalid request.\n\n"sha" is not a valid blob.', status: '422' } };
        if (after !== undefined && body.sha !== after) return { status: 409, json: { message: `${path} does not match ${body.sha}`, status: '409' } };
        const sha = store(decodeBase64(body.content ?? ''));
        github.files.set(path, sha);
        github.commits.push({ path, message: body.message ?? '' });
        return { status: after === undefined ? 201 : 200, json: { content: fileJson(path, sha), commit: { sha: `c${counter}`, message: body.message } } };
      }
      if (req.method === 'DELETE') {
        if (after === undefined) return notFound();
        if (body.sha !== after) return { status: 409, json: { message: `${path} does not match ${body.sha}`, status: '409' } };
        github.files.delete(path);
        github.commits.push({ path, message: body.message ?? '' });
        return { json: { content: null, commit: { sha: `c${counter}`, message: body.message } } };
      }
      return notFound();
    },
  });
  return github;
}
