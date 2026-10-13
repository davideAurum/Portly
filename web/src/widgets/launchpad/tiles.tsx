/**
 * Pieces shared by the launch pad's view board (Widget.tsx) and its edit board (EditBoard.tsx,
 * loaded only when edit mode needs drag and drop — PERF-1): tile body, group header, board frame.
 */
import { useId, type CSSProperties, type ReactNode, type Ref } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Bookmark, BookmarkGroup } from '@portly/shared';
import { safeColor } from '../../lib/color.ts';
import type { LaunchpadConfig } from './index.ts';
import { SiteIcon } from './SiteIcon.tsx';
import styles from './Launchpad.module.css';

export const ICON_PX = { s: 24, m: 32, l: 44 } as const;
export const LIST_ICON_PX = { s: 16, m: 20, l: 26 } as const;

/** The board's CSS variables (also on the drag overlay, which is portalled out of the board). */
export function boardStyle(config: LaunchpadConfig): CSSProperties {
  return {
    '--lp-icon': `${ICON_PX[config.iconSize]}px`,
    '--lp-list-icon': `${LIST_ICON_PX[config.iconSize]}px`,
    '--lp-columns': config.columns === 'auto' ? undefined : String(config.columns),
    '--lp-group-columns': config.groupColumns === 'auto' ? undefined : String(config.groupColumns),
  } as CSSProperties;
}

export function BoardFrame({ config, editMode, children }: { config: LaunchpadConfig; editMode: boolean; children: ReactNode }) {
  return (
    <div
      className={styles.board}
      style={boardStyle(config)}
      data-style={config.style}
      data-size={config.iconSize}
      data-labels={config.showLabels ? 'true' : 'false'}
      data-columns={config.columns === 'auto' ? 'auto' : 'fixed'}
      data-group-layout={config.groupLayout}
      data-group-columns={config.groupColumns === 'auto' ? 'auto' : 'fixed'}
      data-density={config.listDensity}
      data-detail={config.listDetailPlacement}
      data-edit={editMode ? 'true' : undefined}
      data-no-grid-drag=""
    >
      {children}
    </div>
  );
}

/** Whether a tile shows the bookmark's name (the link is labelled with it otherwise). */
export function showsTitle(config: LaunchpadConfig): boolean {
  if (config.style === 'tiles') return config.showLabels;
  // A list row always shows something: the name when nothing else is left.
  return config.listTitle || (config.listDetail === 'none' && !config.listIcons);
}

/** The address a list row shows next to (or under) the name, if any. */
export function detailLabel(url: string, detail: LaunchpadConfig['listDetail']): string | null {
  if (detail === 'none') return null;
  return detail === 'url' ? urlLabel(url) : hostLabel(url);
}

export function TileBody({ bookmark, config }: { bookmark: Bookmark; config: LaunchpadConfig }) {
  const list = config.style === 'list';
  const px = list ? LIST_ICON_PX[config.iconSize] : ICON_PX[config.iconSize];
  const letter = bookmark.iconMode === 'letter';
  const title = showsTitle(config) ? <span className={styles.label}>{bookmark.title}</span> : null;
  const detail = list ? detailLabel(bookmark.url, config.listDetail) : null;
  const host = detail ? <span className={styles.host}>{detail}</span> : null;
  return (
    <>
      {!list || config.listIcons ? (
        <span className={styles.iconWrap}>
          <SiteIcon label={bookmark.title} iconId={letter ? null : bookmark.iconId} letter={letter} letterColor={bookmark.letterColor} size={px} />
        </span>
      ) : null}
      {list && config.listDetailPlacement === 'below' && title && host ? (
        <span className={styles.lines}>
          {title}
          {host}
        </span>
      ) : (
        <>
          {title}
          {host}
        </>
      )}
    </>
  );
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The address without the scheme, `www.` or a lone trailing slash. */
export function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host.replace(/^www\./, '')}${path === '/' ? '' : path}`;
  } catch {
    return url;
  }
}

interface GroupShellProps {
  group: BookmarkGroup;
  showHeader: boolean;
  onToggle(): void;
  /** Edit-mode actions next to the header (add, edit, delete group). */
  actions?: ReactNode;
  /** The drop target ref (edit mode). */
  sectionRef?: Ref<HTMLElement>;
  over?: boolean;
  /** Group columns this group spans (columns layout). */
  span?: number;
  /** Renders the group's list; `bodyId` is the id the header's aria-controls points at. */
  children(bodyId: string): ReactNode;
}

/** A group: its header (collapse toggle, color, count, actions) and — unless collapsed — its list. */
export function GroupShell({ group, showHeader, onToggle, actions, sectionRef, over, span = 1, children }: GroupShellProps) {
  const collapsed = group.collapsed && showHeader;
  const color = safeColor(group.color);
  // Unique per widget instance: several launch pads may show the same group.
  const bodyId = `${useId()}-group`;
  return (
    <section
      ref={sectionRef}
      className={styles.group}
      style={span > 1 ? ({ '--lp-span': String(span) } as CSSProperties) : undefined}
      data-span={span > 1 ? String(span) : undefined}
      data-group-id={group.id}
      data-over={over ? 'true' : undefined}
      aria-label={showHeader ? undefined : group.name}
    >
      {showHeader ? (
        <header className={styles.groupHeader} style={color ? ({ '--lp-group-color': color } as CSSProperties) : undefined}>
          <button type="button" className={styles.groupToggle} aria-expanded={!collapsed} aria-controls={collapsed ? undefined : bodyId} onClick={onToggle}>
            <ChevronRight aria-hidden="true" className={styles.chevron} data-open={!group.collapsed ? 'true' : undefined} />
            {color ? <span className={styles.groupDot} aria-hidden="true" /> : null}
            <span className={styles.groupName}>{group.name}</span>
            <span className={styles.groupCount}>
              {group.bookmarks.length}
              <span className="hb-visually-hidden"> bookmarks</span>
            </span>
          </button>
          {actions ? <span className={styles.groupActions}>{actions}</span> : null}
        </header>
      ) : null}
      {collapsed ? null : children(bodyId)}
    </section>
  );
}
