import { lazy } from 'react';
import { Trophy } from 'lucide-react';
import { z } from 'zod';
import { SportsLeagueId, SportsTeamId } from '@portly/shared';
import { lazyWithPreload } from '../lazyWidget.ts';
import type { WidgetDefinition } from '../types.ts';

export const MAX_FAVORITE_TEAMS = 16;
export const MAX_GAMES_PER_KIND = 5;
export const MAX_UPCOMING_DAYS = 30;

/** Logos must come from ESPN's image host (the only one the page's CSP allows). */
const LogoUrl = z
  .string()
  .max(512)
  .regex(/^https:\/\/a\.espncdn\.com\//)
  .nullable()
  .catch(null);

export const FavoriteTeamSchema = z.object({
  league: SportsLeagueId,
  id: SportsTeamId,
  /** Kept so the widget can label the team before (or without) its games loading. */
  name: z.string().trim().min(1).max(120),
  abbreviation: z.string().trim().max(12).default(''),
  logo: LogoUrl.default(null),
});
export type FavoriteTeam = z.output<typeof FavoriteTeamSchema>;

export const sportsConfigSchema = z.object({
  teams: z.array(FavoriteTeamSchema).max(MAX_FAVORITE_TEAMS).default([]),
  /** Finished games shown per team (most recent first). */
  recentGames: z.number().int().min(0).max(MAX_GAMES_PER_KIND).default(1),
  /** Upcoming games shown per team (soonest first). */
  upcomingGames: z.number().int().min(0).max(MAX_GAMES_PER_KIND).default(1),
  /** Only upcoming games starting within this many days. */
  upcomingDays: z.number().int().min(1).max(MAX_UPCOMING_DAYS).default(14),
  /** Show each team's season record next to its name. */
  showRecords: z.boolean().default(false),
});
export type SportsConfig = z.output<typeof sportsConfigSchema>;

export const definition: WidgetDefinition<SportsConfig> = {
  type: 'sports',
  title: 'Sports scores',
  description: 'Live scores, recent results and upcoming games for your favorite teams, with box scores and where to watch.',
  icon: Trophy,
  defaultSize: { w: 4, h: 7, minW: 3, minH: 3 },
  configSchema: sportsConfigSchema,
  Component: lazyWithPreload(() => import('./Widget.tsx')),
  Settings: lazy(() => import('./Settings.tsx')),
  stackSizing: 'content',
};
