import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import mainSource from './main.tsx?raw';
import './zodConfig.ts';

describe('zod browser config (§4.3: CSP without unsafe-eval)', () => {
  it('turns on jitless so zod never probes new Function()', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('is the first import of main.tsx, ahead of every schema-defining module', () => {
    const firstImport = mainSource
      .split('\n')
      .map((line) => line.trimEnd())
      .find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './zodConfig.ts';");
  });

  it('still parses and rejects objects in jitless mode', () => {
    const schema = z.object({ a: z.string(), n: z.number().default(1) }).strict();
    expect(schema.parse({ a: 'x' })).toEqual({ a: 'x', n: 1 });
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
  });
});
