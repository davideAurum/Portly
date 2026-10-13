/**
 * Feeds widget: headlines from the configured RSS / Atom feeds, merged newest first. Each row
 * links to the article (new tab, through `linkProps`), with the source and a relative time, and
 * optionally a two-line summary. Feeds that fail show a notice row with Retry while the others
 * keep working; stale data stays on screen with "Updated N min ago". Everything feed-supplied is
 * plain text from the server and rendered as React text.
 */
import { useMemo } from 'react';
import { CircleAlert, Newspaper, RefreshCw, Rss } from 'lucide-react';
import { useFeeds } from '../../api/feeds.ts';
import { useWidgetFrame, WidgetActions } from '../../grid/WidgetContext.tsx';
import { linkProps } from '../../lib/openUrl.ts';
import { Button } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage } from '../../ui/toast.ts';
import type { WidgetProps } from '../types.ts';
import type { FeedsConfig } from './index.ts';
import { mergeFeedItems, sourceName, type FeedRow } from './model.ts';
import styles from './Feeds.module.css';

export default function FeedsWidget({ config, size }: WidgetProps<FeedsConfig>) {
  const frame = useWidgetFrame();
  const compact = size.h <= 3 || size.w <= 3;
  const urls = useMemo(() => config.feeds.map((f) => f.url), [config.feeds]);
  const queries = useFeeds(urls);

  const entries = config.feeds.map((source, i) => ({ source, query: queries[i]! }));
  const rows = mergeFeedItems(entries.map((e) => ({ source: e.source, feed: e.query.data })), config.maxItems);

  if (config.feeds.length === 0) {
    return (
      <EmptyState
        icon={Rss}
        compact={compact}
        title="No feeds yet"
        body="Add RSS or Atom feeds — or just a site's address — to see the latest headlines here."
        action={
          frame.canOpenSettings ? (
            <Button size="sm" variant="primary" onClick={() => frame.openSettings({ focus: 'feed-url' })}>
              Add feeds
            </Button>
          ) : undefined
        }
      />
    );
  }

  const loaded = entries.filter((e) => e.query.data !== undefined);
  const failed = entries.filter((e) => e.query.data === undefined && e.query.isError);
  const retryAll = () => {
    for (const e of entries) if (e.query.isError) void e.query.refetch();
  };

  if (loaded.length === 0) {
    if (failed.length === entries.length) {
      return <ErrorState error={failed[0]!.query.error} onRetry={retryAll} compact={compact} />;
    }
    return <SkeletonList rows={Math.min(6, Math.max(2, size.h - 2))} avatar={false} />;
  }

  // The oldest data on screen, and an error when a refresh of shown data failed.
  const updatedAt = Math.min(...loaded.map((e) => e.query.dataUpdatedAt));
  const refreshError = loaded.find((e) => e.query.isError)?.query.error;
  const showSource = config.showSource && config.feeds.length > 1;

  return (
    <div className={styles.root}>
      <WidgetActions>
        <StaleIndicator updatedAt={updatedAt} error={refreshError} onRetry={retryAll} />
      </WidgetActions>
      {failed.length > 0 ? (
        <ul className={styles.notices} aria-label="Feeds with problems">
          {failed.map(({ source, query }) => (
            <li key={source.url} className={styles.notice} data-testid="feed-error">
              <CircleAlert className={styles.noticeIcon} aria-hidden="true" />
              <div className={styles.noticeText}>
                <strong>{sourceName(source)}</strong>
                <span className={styles.noticeMessage}>{errorMessage(query.error)}</span>
              </div>
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void query.refetch()}>
                Retry
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.list} aria-label="Headlines">
          {rows.map((row) => (
            <HeadlineRow key={row.key} row={row} showSource={showSource} showSummary={config.showSummary} />
          ))}
        </ul>
      ) : (
        <div className={styles.fill}>
          <EmptyState icon={Newspaper} compact={compact} title="Nothing new" body="These feeds have no items right now." />
        </div>
      )}
    </div>
  );
}

function HeadlineRow({ row, showSource, showSummary }: { row: FeedRow; showSource: boolean; showSummary: boolean }) {
  const { item } = row;
  const link = linkProps(item.url);
  const content = (
    <>
      <span className={styles.title}>{item.title}</span>{' '}
      {showSource || item.published ? (
        <span className={styles.meta}>
          {showSource ? <span className={styles.source}>{row.source}</span> : null}
          {showSource && item.published ? <span aria-hidden="true">·</span> : null}
          {item.published ? <RelativeTime className={styles.time} date={item.published} /> : null}
        </span>
      ) : null}
      {showSummary && item.summary ? (
        <>
          {' '}
          <span className={styles.summary}>{item.summary}</span>
        </>
      ) : null}
    </>
  );
  return (
    <li className={styles.row}>
      {link ? (
        <a className={styles.link} {...link} title={item.author ? `${item.title} — ${item.author}` : undefined}>
          {content}
        </a>
      ) : (
        <div className={styles.link}>{content}</div>
      )}
    </li>
  );
}
