import { lazy } from 'react';
import { StickyNote } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

/**
 * Longest note, in UTF-16 code units. Even when every one serializes as a six-byte `\uXXXX`
 * escape the config stays under the backends' 64 KB widget config limit.
 */
export const MAX_NOTE_LENGTH = 10_000;

/**
 * Each field falls back to its default on its own: an invalid config would otherwise reset the
 * whole widget (§10.3), and a note shown empty would be overwritten by the next keystroke.
 */
export const notesConfigSchema = z.object({
  /** The note, plain text. Overlong text (a hand-edited import) is cut, not dropped. */
  text: z
    .preprocess((value) => (typeof value === 'string' ? value.slice(0, MAX_NOTE_LENGTH) : value), z.string().max(MAX_NOTE_LENGTH))
    .catch('')
    .default(''),
  textSize: z.enum(['sm', 'md', 'lg']).catch('md').default('md'),
  font: z.enum(['sans', 'mono']).catch('sans').default('sans'),
  spellcheck: z.boolean().catch(true).default(true),
});
export type NotesConfig = z.output<typeof notesConfigSchema>;

export const definition: WidgetDefinition<NotesConfig> = {
  type: 'notes',
  title: 'Notes',
  description: 'A plain-text note, saved as you type. Add one per topic.',
  icon: StickyNote,
  // The size both backends give a type without its own entry when it is added (4 x 4).
  defaultSize: { w: 4, h: 4, minW: 2, minH: 2 },
  configSchema: notesConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
};
