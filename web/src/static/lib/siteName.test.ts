import { describe, expect, it } from 'vitest';
import { siteName } from './siteName.ts';

describe('siteName (static copy of the launchpad helper)', () => {
  it.each([
    ['https://www.netflix.com/', 'Netflix'],
    ['https://stackoverflow.com/questions', 'Stackoverflow'],
    ['https://news.bbc.co.uk/', 'Bbc'],
    ['https://example.com.au/', 'Example'],
    ['http://192.168.1.10:8080/', '192.168.1.10'],
    ['http://nas/', 'nas'],
    ['http://[::1]:3000/', '[::1]'],
    ['https://sub.domain.github.io/', 'Github'],
    ['not a url', 'not a url'],
  ])('%s → %s', (url, expected) => {
    expect(siteName(url)).toBe(expected);
  });
});
