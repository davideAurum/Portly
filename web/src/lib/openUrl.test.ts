import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignLocation, isAppRoute, linkProps, openUrl, safeHref } from './openUrl.ts';

describe('safeHref', () => {
  it('accepts absolute http(s) URLs and returns them normalized', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    expect(safeHref('  http://example.com/a?b=c#d  ')).toBe('http://example.com/a?b=c#d');
    expect(safeHref('https://xn--bcher-kva.example/')).toBe('https://xn--bcher-kva.example/');
    expect(safeHref('https://bücher.example/')).toBe('https://xn--bcher-kva.example/');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini',
    'blob:https://example.com/uuid',
    'ftp://example.com/',
    'chrome://settings',
    'https://user:pass@example.com/',
    'https://example.com/\u0000',
    'https://exa\nmple.com/',
    '//evil.example/',
    '/api/export',
    'example.com',
    '',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('refuses %j', (value) => {
    expect(safeHref(value)).toBeUndefined();
  });

  it('refuses non-strings', () => {
    for (const value of [null, undefined, 42, {}, ['https://example.com']]) expect(safeHref(value)).toBeUndefined();
  });

  it('accepts in-app hash routes unless disabled', () => {
    expect(isAppRoute('#/settings/accounts')).toBe(true);
    expect(safeHref('#/settings/todoist')).toBe('#/settings/todoist');
    expect(safeHref('#/')).toBe('#/');
    expect(safeHref('#/settings/<script>')).toBeUndefined();
    expect(safeHref('#/settings/accounts', { allowAppRoutes: false })).toBeUndefined();
  });
});

describe('linkProps', () => {
  it('opens external links in a new tab with noopener noreferrer by default', () => {
    expect(linkProps('https://example.com/x')).toEqual({ href: 'https://example.com/x', target: '_blank', rel: 'noopener noreferrer' });
    expect(linkProps('https://example.com/x', { newTab: false })).toEqual({ href: 'https://example.com/x' });
    expect(linkProps('#/settings/general')).toEqual({ href: '#/settings/general' });
    expect(linkProps('javascript:alert(1)')).toBeNull();
  });
});

describe('openUrl / assignLocation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens safe URLs with noopener,noreferrer and refuses unsafe ones', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openUrl('https://example.com/a')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
    expect(openUrl('javascript:alert(1)')).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('assignLocation only navigates to absolute http(s) URLs', () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location);
    expect(assignLocation('javascript:alert(1)')).toBe(false);
    expect(assignLocation('#/settings')).toBe(false);
    expect(assignLocation('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });
});
