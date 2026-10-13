import { describe, expect, it } from 'vitest';
import { siteName } from './BookmarkDialog.tsx';

describe('siteName (UX-1 fallback title)', () => {
  it.each([
    ['https://www.netflix.com/', 'Netflix'],
    ['https://stackoverflow.com/questions', 'Stackoverflow'],
    ['https://news.bbc.co.uk/', 'Bbc'],
    ['https://example.com.au/', 'Example'],
    ['http://192.168.1.10:8080/', '192.168.1.10'],
    ['http://nas/', 'nas'],
  ])('%s → %s', (url, expected) => {
    expect(siteName(url)).toBe(expected);
  });
});
