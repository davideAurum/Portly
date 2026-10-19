/**
 * `renderWithProviders(ui, {apiMocks})` (§13): renders inside a fresh QueryClient (no retries, no
 * persistence) with `fetch` stubbed, plus a sonner Toaster so toasts can be asserted. `apiMocks`
 * maps `'METHOD /api/path'` (optionally with the query string) to a JSON value, a
 * {@link mockResponse}, a `Response` (answered as it is, e.g. image bytes), or a function of the
 * request. Unmocked API calls answer 501 and are recorded in `unmatched`.
 */
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { Toaster } from 'sonner';
import { vi } from 'vitest';

export interface MockRequest {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
  /** Values of `:param` segments when the mock key is a pattern (`'PATCH /api/profiles/:id'`). */
  params: Record<string, string>;
}

const RESPONSE = Symbol('mockResponse');

export interface MockResponse {
  [RESPONSE]: true;
  status: number;
  body: unknown;
}

/** A mocked response with an explicit status (e.g. an API error body). */
export function mockResponse(status: number, body?: unknown): MockResponse {
  return { [RESPONSE]: true, status, body };
}

/** An API error response in the server's `{error: {...}}` shape. */
export function mockError(status: number, code: string, message = code, extra: { details?: unknown; accountId?: string } = {}): MockResponse {
  return mockResponse(status, { error: { code, message, ...extra } });
}

export type ApiMock = unknown | MockResponse | Response | ((req: MockRequest) => unknown | MockResponse | Response | Promise<unknown | MockResponse | Response>);

export interface RenderWithProvidersOptions {
  apiMocks?: Record<string, ApiMock>;
  /** Hash route to start on, e.g. '#/settings/about'. */
  route?: string;
  queryClient?: QueryClient;
  /** Render a sonner Toaster (default true). */
  toaster?: boolean;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
  /** Every API request made. */
  requests: MockRequest[];
  /** Requests without a mock. */
  unmatched: MockRequest[];
  /** Requests matching `METHOD /path` (path without the query string). */
  requestsTo(key: string): MockRequest[];
}

function isMockResponse(value: unknown): value is MockResponse {
  return typeof value === 'object' && value !== null && RESPONSE in value;
}

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204 || body === undefined) return new Response(null, { status: status === 200 ? 204 : status });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/** Matches `METHOD /a/:x/b` patterns against a method + path; returns the params or null. */
function matchPattern(key: string, method: string, path: string): Record<string, string> | null {
  const [keyMethod, keyPath] = key.split(' ', 2);
  if (keyMethod !== method || !keyPath || !keyPath.includes(':')) return null;
  const want = keyPath.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(got[i]!);
    else if (segment !== got[i]) return null;
  }
  return params;
}

/** Stubs `fetch` with the given mocks; returns the request logs. */
export function stubApi(apiMocks: Record<string, ApiMock>): { requests: MockRequest[]; unmatched: MockRequest[] } {
  const requests: MockRequest[] = [];
  const unmatched: MockRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // keep raw text
      }
    }
    const req: MockRequest = { method, path: url.pathname, search: url.search, headers: new Headers(init?.headers), body, params: {} };
    requests.push(req);

    let mock = apiMocks[`${method} ${url.pathname}${url.search}`] ?? apiMocks[`${method} ${url.pathname}`];
    if (mock === undefined) {
      for (const [key, candidate] of Object.entries(apiMocks)) {
        const params = matchPattern(key, method, url.pathname);
        if (params) {
          req.params = params;
          mock = candidate;
          break;
        }
      }
    }
    if (mock === undefined) {
      unmatched.push(req);
      return jsonResponse(501, { error: { code: 'internal', message: `No API mock for ${method} ${url.pathname}` } });
    }
    const value = typeof mock === 'function' ? await (mock as (r: MockRequest) => unknown)(req) : mock;
    if (value instanceof Response) return value.clone();
    return isMockResponse(value) ? jsonResponse(value.status, value.body) : jsonResponse(200, value);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, unmatched };
}

export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}): RenderWithProvidersResult {
  const { apiMocks = {}, route, toaster = true } = options;
  if (route !== undefined) window.history.replaceState(null, '', `/${route}`);

  const { requests, unmatched } = stubApi(apiMocks);
  const queryClient = options.queryClient ?? createTestQueryClient();
  // A wrapper (not a wrapping element) so that `rerender(ui)` keeps the providers.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
      {toaster ? <Toaster /> : null}
    </QueryClientProvider>
  );
  const result = render(ui, { wrapper });
  const requestsTo = (key: string) => requests.filter((r) => `${r.method} ${r.path}` === key);
  return { ...result, queryClient, requests, unmatched, requestsTo };
}
