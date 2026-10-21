import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { BODY_LIMITS, RouteTable, deviceMayCall, enrollment, exempt, multipart, paired, pagesMayCall, routeMetaOf, samePc } from './routes.ts';

describe('route metadata', () => {
  it('records tagged handlers with their method and pattern', () => {
    const app = new Hono();
    app.get('/api/health', exempt('health'), (c) => c.text('ok'));
    app.post('/api/uploads', multipart('upload'), (c) => c.text('ok'));
    app.get('/api/plain', (c) => c.text('ok'));
    const table = new RouteTable();
    table.collect(app);
    table.collect(app); // idempotent
    expect(table.list()).toEqual([
      { method: 'GET', pattern: '/api/health', exempt: 'health' },
      { method: 'POST', pattern: '/api/uploads', body: 'upload' },
    ]);
  });

  it('matches params, HEAD as GET, and never by prefix', () => {
    const table = new RouteTable();
    table.record({ method: 'GET', pattern: '/api/icons/:id', exempt: 'image' });
    table.record({ method: 'ALL', pattern: '/api/import/preview', body: 'import' });
    expect(table.match('GET', '/api/icons/abc')).toEqual({ exempt: 'image' });
    expect(table.match('HEAD', '/api/icons/abc')).toEqual({ exempt: 'image' });
    expect(table.match('POST', '/api/icons/abc')).toEqual({});
    expect(table.match('GET', '/api/icons/abc/def')).toEqual({});
    expect(table.match('GET', '/api/iconsabc')).toEqual({});
    expect(table.match('PUT', '/api/import/preview')).toEqual({ body: 'import' });
  });

  it('finds metadata on handlers mounted from sub-apps with their own error handler', () => {
    const sub = new Hono();
    sub.onError((_err, c) => c.text('sub error', 500));
    sub.get('/callback', exempt('oauth-callback'), (c) => c.text('ok'));
    const app = new Hono();
    app.route('/api/oauth/:provider', sub);
    const table = new RouteTable();
    table.collect(app);
    expect(table.match('GET', '/api/oauth/google/callback')).toEqual({ exempt: 'oauth-callback' });
  });

  it('tags are pass-through middleware', async () => {
    const app = new Hono();
    app.get('/x', exempt('health'), (c) => c.text('reached'));
    expect(await (await app.request('/x')).text()).toBe('reached');
    expect(routeMetaOf(() => {})).toBeUndefined();
    expect(routeMetaOf('nope')).toBeUndefined();
  });

  it('paired() composes with exempt() and multipart()', () => {
    const app = new Hono();
    app.get('/api/icons/:id', exempt('image'), paired(), (c) => c.text('ok'));
    app.post('/api/uploads', multipart('upload'), paired(), (c) => c.text('ok'));
    app.get('/api/settings', paired(), (c) => c.text('ok'));
    app.post('/api/vault/reset', (c) => c.text('ok'));
    const table = new RouteTable();
    table.collect(app);
    expect(table.match('GET', '/api/icons/abc')).toEqual({ exempt: 'image', access: 'paired' });
    expect(table.match('HEAD', '/api/icons/abc')).toEqual({ exempt: 'image', access: 'paired' });
    expect(table.match('POST', '/api/uploads')).toEqual({ body: 'upload', access: 'paired' });
    expect(table.match('GET', '/api/settings')).toEqual({ access: 'paired' });
    expect(table.match('POST', '/api/vault/reset')).toEqual({});
    expect(table.match('PUT', '/api/settings')).toEqual({});
    expect(table.match('GET', '/api/unknown')).toEqual({});
    // Untagged routes are not declarations: list() shows the tags only.
    expect(table.list().map((r) => `${r.method} ${r.pattern}`)).toEqual([
      'GET /api/icons/:id',
      'GET /api/icons/:id',
      'POST /api/uploads',
      'POST /api/uploads',
      'GET /api/settings',
    ]);
  });

  it('access fails closed: every matching registration must be paired', () => {
    const app = new Hono();
    app.get('/api/things/:id', paired(), (c) => c.text('any thing'));
    app.get('/api/things/special', (c) => c.text('local only'));
    app.post('/api/things/:id', paired(), (c) => c.text('ok'));
    app.all('/api/things/*', (c) => c.text('catch-all middleware is not a route'));
    const table = new RouteTable();
    table.collect(app);
    expect(table.match('GET', '/api/things/abc')).toEqual({ access: 'paired' });
    // The literal route overlaps the paired pattern but is not paired itself.
    expect(table.match('GET', '/api/things/special')).toEqual({});
    expect(table.match('POST', '/api/things/special')).toEqual({ access: 'paired' });

    const recorded = new RouteTable();
    recorded.record({ method: 'GET', pattern: '/api/x/:id', access: 'paired' });
    recorded.record({ method: 'ALL', pattern: '/api/x/*', exempt: 'image' });
    expect(recorded.match('GET', '/api/x/1')).toEqual({ exempt: 'image' });
    recorded.record({ method: 'ALL', pattern: '/api/x/*', access: 'paired' });
    expect(recorded.match('GET', '/api/x/1')).toEqual({ exempt: 'image', access: 'paired' });
  });

  it('declares the §4.2 body limits', () => {
    expect(BODY_LIMITS).toEqual({ json: 1024 * 1024, upload: 10 * 1024 * 1024, import: 25 * 1024 * 1024 });
  });
});

describe('route access levels', () => {
  it('records samePc() and enrollment() and says who may call each', () => {
    const app = new Hono();
    app.post('/api/vault/reset', samePc(), (c) => c.text('ok'));
    app.post('/api/devices/requests', enrollment(), (c) => c.text('ok'));
    app.get('/api/settings', paired(), (c) => c.text('ok'));
    app.post('/api/pairings', (c) => c.text('ok'));
    const table = new RouteTable();
    table.collect(app);
    const reset = table.match('POST', '/api/vault/reset');
    const enroll = table.match('POST', '/api/devices/requests');
    const settings = table.match('GET', '/api/settings');
    const local = table.match('POST', '/api/pairings');
    expect(reset).toEqual({ access: 'same-pc' });
    expect(enroll).toEqual({ access: 'enrollment' });
    expect(settings).toEqual({ access: 'paired' });
    expect(local).toEqual({});
    expect([reset, enroll, settings, local].map(pagesMayCall)).toEqual([true, false, true, false]);
    expect([reset, enroll, settings, local].map(deviceMayCall)).toEqual([false, true, true, false]);
  });

  it('fails closed to the narrowest access of overlapping registrations', () => {
    const app = new Hono();
    app.get('/api/things/:id', paired(), (c) => c.text('any thing'));
    app.get('/api/things/mine', samePc(), (c) => c.text('this PC only'));
    app.get('/api/things/ask', enrollment(), (c) => c.text('anyone on the remote origin'));
    app.get('/api/things/plain', (c) => c.text('local only'));
    const table = new RouteTable();
    table.collect(app);
    expect(table.match('GET', '/api/things/abc')).toEqual({ access: 'paired' });
    expect(table.match('GET', '/api/things/mine')).toEqual({ access: 'same-pc' });
    // Paired and enrollment agree on devices only, which no level names: local-only.
    expect(table.match('GET', '/api/things/ask')).toEqual({});
    expect(table.match('GET', '/api/things/plain')).toEqual({});

    const recorded = new RouteTable();
    recorded.record({ method: 'GET', pattern: '/api/x/:id', access: 'enrollment' });
    recorded.record({ method: 'GET', pattern: '/api/x/:id', exempt: 'image' });
    expect(recorded.match('GET', '/api/x/1')).toEqual({ exempt: 'image', access: 'enrollment' });
    recorded.record({ method: 'ALL', pattern: '/api/x/*', access: 'same-pc' });
    // Enrollment and same-pc share no caller at all.
    expect(recorded.match('GET', '/api/x/1')).toEqual({ exempt: 'image' });
    // A registration tagged with two levels names more callers than any one level: local-only.
    const both = new RouteTable();
    both.record({ method: 'GET', pattern: '/api/y', access: 'paired' });
    both.record({ method: 'GET', pattern: '/api/y', access: 'enrollment' });
    expect(both.match('GET', '/api/y')).toEqual({});
    // Two paired registrations agree.
    both.record({ method: 'GET', pattern: '/api/z/:id', access: 'paired' });
    both.record({ method: 'ALL', pattern: '/api/z/*', access: 'paired' });
    expect(both.match('GET', '/api/z/1')).toEqual({ access: 'paired' });
  });
});
