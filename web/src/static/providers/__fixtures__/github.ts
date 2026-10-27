/**
 * A small in-memory GitHub for the gist store's tests: the REST routes it uses (`GET /gists`,
 * `POST /gists`, `GET|PATCH|DELETE /gists/{id}`, `GET /gists/{id}/{sha}`) and the raw host, with
 * revisions, 1 MB inline truncation and hooks to inject failures or another browser's write.
 * Answers follow the shapes seen from api.github.com on 2026-10-27. The account is fictional.
 */
import { createFakeFetch, type FakeFetch, type FakeRequest, type FakeResponseSpec } from './fakeFetch.ts';

export const GITHUB_TOKEN = 'github_pat_11TESTTOKEN0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
export const CLASSIC_TOKEN = 'ghp_TestToken0123456789abcdefghijklmnopq';
export const OWNER = 'octo-tester';
const API = 'https://api.github.com';
const RAW = 'https://gist.githubusercontent.com';
/** What the API inlines of each file. */
export const INLINE_LIMIT = 1024 * 1024;

interface Revision {
  version: string;
  files: Map<string, string>;
}

export interface FakeGist {
  id: string;
  public: boolean;
  description: string;
  createdAt: string;
  files: Map<string, string>;
  /** Newest first. */
  history: Revision[];
}

export interface FakeGitHub {
  fake: FakeFetch;
  gists: Map<string, FakeGist>;
  /** Adds a gist as if created earlier (by another browser, or by hand). */
  seed(files: Record<string, string>, options?: { id?: string; public?: boolean; createdAt?: string }): FakeGist;
  /** Changes a gist's files directly (another browser's write); returns the new version. */
  write(id: string, files: Record<string, string | null>): string;
  /** Runs right before a PATCH is applied (to inject a concurrent write); return a spec to answer with it instead. */
  beforePatch: ((req: FakeRequest, gist: FakeGist) => FakeResponseSpec | void) | null;
  /** Answers every API request with this instead, while set. */
  override: ((req: FakeRequest) => FakeResponseSpec | null) | null;
  calls(method?: string, pattern?: RegExp): FakeRequest[];
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

export function createFakeGitHub(): FakeGitHub {
  const gists = new Map<string, FakeGist>();
  const blobs = new Map<string, string>();
  let counter = 0;
  let gistCounter = 0;
  let clock = Date.parse('2026-10-01T00:00:00Z');

  const nextVersion = () => (++counter).toString(16).padStart(40, '0');
  const blobOf = (content: string) => {
    const sha = `b${(++counter).toString(16).padStart(39, '0')}`;
    blobs.set(sha, content);
    return sha;
  };
  const stamp = () => new Date((clock += 1000)).toISOString();

  function fileJson(gist: FakeGist, name: string, content: string, withContent: boolean) {
    const size = utf8(content);
    const raw_url = `${RAW}/${OWNER}/${gist.id}/raw/${blobOf(content)}/${encodeURIComponent(name)}`;
    if (!withContent) return { filename: name, type: 'text/plain', language: null, raw_url, size };
    const truncated = size > INLINE_LIMIT;
    // The API cuts at 1 MB of bytes; these fixtures are ASCII, so characters are bytes.
    return { filename: name, type: 'text/plain', language: null, raw_url, size, truncated, content: truncated ? content.slice(0, INLINE_LIMIT) : content, encoding: 'utf-8' };
  }

  function gistJson(gist: FakeGist, files: Map<string, string>, withContent: boolean, history: Revision[] | null) {
    const out: Record<string, unknown> = {
      url: `${API}/gists/${gist.id}`,
      id: gist.id,
      public: gist.public,
      created_at: gist.createdAt,
      updated_at: gist.createdAt,
      description: gist.description,
      owner: { login: OWNER },
      files: Object.fromEntries([...files].map(([name, content]) => [name, fileJson(gist, name, content, withContent)])),
      truncated: false,
    };
    if (history !== null) out.history = history.map((r) => ({ user: { login: OWNER }, version: r.version, committed_at: gist.createdAt, url: `${API}/gists/${gist.id}/${r.version}` }));
    return out;
  }

  function commit(gist: FakeGist): string {
    const version = nextVersion();
    gist.history.unshift({ version, files: new Map(gist.files) });
    return version;
  }

  function apply(gist: FakeGist, files: Record<string, unknown>): boolean {
    let changed = false;
    for (const [name, value] of Object.entries(files)) {
      if (value === null) changed = gist.files.delete(name) || changed;
      else {
        const content = (value as { content: string }).content;
        if (gist.files.get(name) !== content) changed = true;
        gist.files.set(name, content);
      }
    }
    return changed;
  }

  const github: FakeGitHub = {
    fake: createFakeFetch(),
    gists,
    seed(files, options = {}) {
      const id = options.id ?? `aa${(++gistCounter).toString(16).padStart(30, '0')}`;
      const gist: FakeGist = {
        id,
        public: options.public ?? false,
        description: 'seeded',
        createdAt: options.createdAt ?? stamp(),
        files: new Map(Object.entries(files)),
        history: [],
      };
      commit(gist);
      gists.set(id, gist);
      return gist;
    },
    write(id, files) {
      const gist = gists.get(id)!;
      apply(gist, Object.fromEntries(Object.entries(files).map(([name, content]) => [name, content === null ? null : { content }])));
      return commit(gist);
    },
    beforePatch: null,
    override: null,
    calls(method, pattern) {
      return github.fake.calls.filter((c) => (method === undefined || c.method === method) && (pattern === undefined || pattern.test(c.url)));
    },
  };

  github.fake.add({
    match: /./,
    respond: (req) => {
      const url = new URL(req.url);
      if (url.origin === RAW) {
        const parts = url.pathname.split('/');
        const content = blobs.get(parts[4] ?? '');
        return content === undefined ? { status: 404, text: '404: Not Found' } : { text: content, headers: { 'content-type': 'text/plain; charset=utf-8' } };
      }
      const overridden = github.override?.(req);
      if (overridden) return overridden;
      const path = url.pathname;
      if (path === '/gists' && req.method === 'GET') {
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        // Newest first, like GitHub.
        const all = [...gists.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { json: all.slice((page - 1) * perPage, page * perPage).map((g) => gistJson(g, g.files, false, null)) };
      }
      if (path === '/gists' && req.method === 'POST') {
        const body = JSON.parse(req.body ?? '{}') as { description: string; public: boolean; files: Record<string, { content: string }> };
        const gist = github.seed(Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])), { public: body.public });
        gist.description = body.description;
        return { status: 201, json: gistJson(gist, gist.files, true, gist.history) };
      }
      const match = /^\/gists\/([^/]+)(?:\/([0-9a-f]{40}))?$/.exec(path);
      const gist = match ? gists.get(match[1]!) : undefined;
      if (!match || !gist) return { status: 404, json: { message: 'Not Found', status: '404' } };
      if (match[2] !== undefined) {
        const revision = gist.history.find((r) => r.version === match[2]);
        return revision ? { json: gistJson(gist, revision.files, true, gist.history) } : { status: 404, json: { message: 'Not Found' } };
      }
      switch (req.method) {
        case 'GET':
          return { json: gistJson(gist, gist.files, true, gist.history) };
        case 'DELETE':
          gists.delete(gist.id);
          return { status: 204 };
        case 'PATCH': {
          const injected = github.beforePatch?.(req, gist);
          if (injected) return injected;
          const body = JSON.parse(req.body ?? '{}') as { files: Record<string, unknown> };
          if (apply(gist, body.files)) commit(gist);
          return { json: gistJson(gist, gist.files, true, gist.history) };
        }
      }
      return { status: 404, json: { message: 'Not Found' } };
    },
  });
  return github;
}
