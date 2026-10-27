/**
 * A fake OneDrive app folder for launch pad sync tests, as routes for `createFakeFetch()`: Graph's
 * item metadata (`select=...` with a download URL), downloads from the content host, simple `PUT`
 * uploads with `If-Match` or `@microsoft.graph.conflictBehavior=fail`, and deletes, behaving as the
 * spike recorded (design section 13): a stale `If-Match` is `412`, `fail` on an existing item is
 * `409`, and `If-Match` on a missing file creates it (`201`).
 */
import type { FakeFetchRoute, FakeRequest, FakeResponseSpec } from './fakeFetch.ts';

export const APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot:';
export const DOWNLOAD_ORIGIN = 'https://my.microsoftpersonalcontent.com';

interface StoredFile {
  bytes: Uint8Array;
  eTag: string;
}

export interface FakeOneDrive {
  /** Files by path (`/launchpad.json`, `/launchpad-icons/<id>`). */
  readonly files: Map<string, StoredFile>;
  readonly routes: FakeFetchRoute[];
  /** Runs once, right before the next upload of the main file is answered (another browser writing in between). */
  beforeNextWrite: (() => void) | null;
  /** Answer the next requests to Graph with this instead (once each). */
  failNext: FakeResponseSpec[];
  /** Writes a file as another program would. */
  put(path: string, content: string | Uint8Array): void;
  text(path: string): string | null;
  /** Requests by kind, for assertions. */
  count(kind: 'meta' | 'download' | 'put' | 'delete'): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createFakeOneDrive(): FakeOneDrive {
  const files = new Map<string, StoredFile>();
  const links = new Map<string, string>();
  const counts = { meta: 0, download: 0, put: 0, delete: 0 };
  let version = 0;

  const write = (path: string, bytes: Uint8Array): StoredFile => {
    const file = { bytes, eTag: `"{FAKE-${path}},${++version}"` };
    files.set(path, file);
    return file;
  };
  const item = (path: string, file: StoredFile): Record<string, unknown> => {
    const token = `t${links.size + 1}`;
    links.set(token, path);
    return {
      id: `item-${path}`,
      eTag: file.eTag,
      cTag: `c${file.eTag}`,
      size: file.bytes.byteLength,
      '@microsoft.graph.downloadUrl': `${DOWNLOAD_ORIGIN}/download/${token}?tempauth=secret`,
    };
  };
  const pathOf = (url: string): string => url.slice(APPROOT.length).split(/[:?]/)[0]!;

  const drive: FakeOneDrive = {
    files,
    beforeNextWrite: null,
    failNext: [],
    put(path, content) {
      write(path, typeof content === 'string' ? encoder.encode(content) : content);
    },
    text(path) {
      const file = files.get(path);
      return file ? decoder.decode(file.bytes) : null;
    },
    count: (kind) => counts[kind],
    routes: [
      {
        match: DOWNLOAD_ORIGIN,
        method: 'GET',
        respond: (req: FakeRequest) => {
          counts.download++;
          const token = new URL(req.url).pathname.split('/').at(-1) ?? '';
          const file = files.get(links.get(token) ?? '');
          return file ? { bytes: file.bytes } : { status: 404 };
        },
      },
      {
        match: APPROOT,
        respond: (req: FakeRequest): FakeResponseSpec => {
          const failure = drive.failNext.shift();
          if (failure) return failure;
          if (!req.headers.get('authorization')?.startsWith('Bearer ')) return { status: 401, json: { error: { code: 'unauthenticated' } } };
          const path = pathOf(req.url);
          const existing = files.get(path);
          if (req.method === 'GET') {
            counts.meta++;
            return existing ? { json: item(path, existing) } : { status: 404, json: { error: { code: 'itemNotFound' } } };
          }
          if (req.method === 'DELETE') {
            counts.delete++;
            if (!existing) return { status: 404, json: { error: { code: 'itemNotFound' } } };
            files.delete(path);
            return { status: 204 };
          }
          counts.put++;
          if (path === '/launchpad.json' && drive.beforeNextWrite) {
            const race = drive.beforeNextWrite;
            drive.beforeNextWrite = null;
            race();
          }
          const current = files.get(path);
          const ifMatch = req.headers.get('if-match');
          if (req.url.includes('conflictBehavior=fail') && current) return { status: 409, json: { error: { code: 'nameAlreadyExists' } } };
          if (ifMatch !== null && current && current.eTag !== ifMatch) return { status: 412, json: { error: { code: 'notAllowed' } } };
          const created = !current;
          const file = write(path, req.bytes ?? new Uint8Array(0));
          return { status: created ? 201 : 200, json: item(path, file) };
        },
      },
    ],
  };
  return drive;
}
