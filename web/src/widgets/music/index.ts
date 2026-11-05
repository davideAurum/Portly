import { lazy } from 'react';
import { Music } from 'lucide-react';
import { z } from 'zod';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const musicConfigSchema = z.object({
  /** The account to control; null, or one that is gone, is the first with music switched on. */
  accountId: z.string().max(512).nullable().catch(null).default(null),
});
export type MusicConfig = z.output<typeof musicConfigSchema>;

export const definition: WidgetDefinition<MusicConfig> = {
  type: 'music',
  title: 'Music',
  description: 'See what is playing and control it from here: play, pause, skip, volume and which device it plays on. Works with Spotify.',
  icon: Music,
  defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
  configSchema: musicConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
};
