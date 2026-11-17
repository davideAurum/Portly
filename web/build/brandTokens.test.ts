import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/brand/tokens.json is the design system's copy of web/src/styles/tokens.css, the source.
// This test keeps the two in step: change a value in tokens.css, then the same value in
// tokens.json (docs/brand/README.md, "Tokens").

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(path.join(root, 'web', 'src', 'styles', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface TokenEntry {
  name: string;
  value: string | Record<string, string>;
}
interface TokenFamily {
  tokens: TokenEntry[];
}
interface BrandTokens {
  color: TokenFamily & { themes: { id: string }[] };
  type: { families: Record<string, string> };
  [family: string]: unknown;
}
const tokens = JSON.parse(readFileSync(path.join(root, 'docs', 'brand', 'tokens.json'), 'utf8')) as BrandTokens;

/** The custom properties declared in the first rule whose selector is exactly `selector`. */
function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `tokens.css has no "${selector}" rule`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const map = new Map<string, string>();
  for (const match of body.matchAll(/--(pt-[\w-]+):\s*([^;]+);/g)) map.set(match[1] ?? '', (match[2] ?? '').trim().replace(/\s+/g, ' '));
  return map;
}

const light = declarations(':root');
const dark = declarations(":root[data-theme='dark']");

/** Families of tokens.json whose entries are pt- custom properties. */
const CSS_FAMILIES = ['color', 'shadow', 'spacing', 'radius', 'fontSize', 'size', 'opacity', 'blur'] as const;

/** Literal values in tokens.css that the README documents instead of tokens.json. */
const DOCUMENTED_ONLY = new Set(['pt-font-sans', 'pt-font-mono', 'pt-glass-filter', 'pt-ease', 'pt-duration', 'pt-backdrop', 'pt-backdrop-blur']);

function entries(): TokenEntry[] {
  return CSS_FAMILIES.flatMap((family) => (tokens[family] as TokenFamily | undefined)?.tokens ?? []).filter((t) => t.name.startsWith('pt-'));
}

describe('docs/brand/tokens.json', () => {
  it('matches tokens.css in light and dark', () => {
    for (const token of entries()) {
      const value = typeof token.value === 'string' ? { light: token.value } : token.value;
      expect(light.get(token.name), `${token.name} (light)`).toBe(value.light);
      expect(dark.get(token.name) ?? light.get(token.name), `${token.name} (dark)`).toBe(value.dark ?? value.light);
    }
  });

  it('lists every literal value of tokens.css', () => {
    const listed = new Set(entries().map((t) => t.name));
    const missing = [...light]
      .filter(([name, value]) => !value.includes('var(') && !value.includes('color-mix(') && !DOCUMENTED_ONLY.has(name) && !listed.has(name))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('uses the font stacks of tokens.css', () => {
    expect(tokens.type.families.sans).toBe(light.get('pt-font-sans')?.replaceAll("'", '"'));
    expect(tokens.type.families.mono).toBe(light.get('pt-font-mono')?.replaceAll("'", '"'));
  });
});
