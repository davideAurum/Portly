/**
 * Settings sections (§10.5): hash routes `#/settings/<section>`, in navigation order.
 * Foundation implements General, Appearance, Accounts, Profiles, Import/Export and About;
 * features own Search, Bookmarks, Calendars and Todoist, and diagnostics owns Diagnostics (§17),
 * which every backend shows (the in-browser one: the hybrid state and this browser's events).
 * Every backend shows every section: the in-browser one has Accounts and Calendars too
 * (Outlook.com signs in and syncs from the browser); a section adapts to what its page load can do.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Bookmark,
  CalendarDays,
  Info,
  Layers,
  ListChecks,
  Palette,
  Search,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export const SETTINGS_SECTION_IDS = [
  'general',
  'appearance',
  'search',
  'bookmarks',
  'accounts',
  'calendars',
  'todoist',
  'profiles',
  'import-export',
  'diagnostics',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType>;
}

/** Every section, in navigation order. */
export const ALL_SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  { id: 'general', label: 'General', icon: SlidersHorizontal, Component: lazy(() => import('./sections/General.tsx')) },
  { id: 'appearance', label: 'Appearance', icon: Palette, Component: lazy(() => import('./sections/Appearance.tsx')) },
  { id: 'search', label: 'Search', icon: Search, Component: lazy(() => import('./sections/Search.tsx')) },
  { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark, Component: lazy(() => import('./sections/Bookmarks.tsx')) },
  { id: 'accounts', label: 'Accounts', icon: UserRound, Component: lazy(() => import('./sections/Accounts.tsx')) },
  { id: 'calendars', label: 'Calendars', icon: CalendarDays, Component: lazy(() => import('./sections/Calendars.tsx')) },
  { id: 'todoist', label: 'Todoist', icon: ListChecks, Component: lazy(() => import('./sections/Todoist.tsx')) },
  { id: 'profiles', label: 'Profiles', icon: Layers, Component: lazy(() => import('./sections/Profiles.tsx')) },
  {
    id: 'import-export',
    label: 'Import & export',
    icon: ArrowLeftRight,
    Component: lazy(() => import('./sections/ImportExport.tsx')),
  },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity, Component: lazy(() => import('./sections/Diagnostics.tsx')) },
  { id: 'about', label: 'About', icon: Info, Component: lazy(() => import('./sections/About.tsx')) },
]);

export function getSettingsSection(id: SettingsSectionId): SettingsSection {
  const section = ALL_SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}
