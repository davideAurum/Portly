/**
 * Feeds widget settings: add a feed by URL (a site's address works too — the server finds the feed
 * the page advertises), checked by fetching it before it is added; rename, reorder and remove
 * feeds; number of headlines, summaries and source names. Changes go to the dialog draft.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Rss, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { isSafeHttpUrl } from '@portly/shared';
import { feedCheckQuery, feedQuery } from '../../api/feeds.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input } from '../../ui/Input.tsx';
import { Slider, Switch } from '../../ui/Toggles.tsx';
import { errorMessage } from '../../ui/toast.ts';
import type { WidgetSettingsProps } from '../types.ts';
import { MAX_FEEDS, MAX_FEED_ITEMS_SHOWN, MIN_FEED_ITEMS, type FeedSource, type FeedsConfig } from './index.ts';
import { normalizeFeedInput } from './model.ts';
import styles from './Settings.module.css';

export default function FeedsSettings({ value, onChange }: WidgetSettingsProps<FeedsConfig>) {
  const update = (patch: Partial<FeedsConfig>) => onChange({ ...value, ...patch });
  const feeds = value.feeds;
  const setFeeds = (next: FeedSource[]) => update({ feeds: next });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= feeds.length) return;
    const next = [...feeds];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setFeeds(next);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.group} role="group" aria-labelledby="hb-feeds-list">
        <div className={styles.groupHeader}>
          <p id="hb-feeds-list" className={styles.groupLabel}>
            Feeds
          </p>
          <span className={styles.count}>
            {feeds.length} / {MAX_FEEDS}
          </span>
        </div>
        {feeds.length > 0 ? (
          <ul className={styles.list}>
            {feeds.map((feed, index) => (
              <FeedRowEditor
                key={feed.url}
                feed={feed}
                first={index === 0}
                last={index === feeds.length - 1}
                onTitleChange={(title) => setFeeds(feeds.map((f, i) => (i === index ? { ...f, title } : f)))}
                onRemove={() => setFeeds(feeds.filter((_, i) => i !== index))}
                onMove={(delta) => move(index, delta)}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.note}>Paste the address of an RSS or Atom feed, or of a site that has one.</p>
        )}
        <AddFeed existing={feeds.map((f) => f.url)} disabled={feeds.length >= MAX_FEEDS} onAdd={(feed) => setFeeds([...feeds, feed])} />
      </div>

      <Field label="Headlines shown">
        <Slider
          value={value.maxItems}
          min={MIN_FEED_ITEMS}
          max={MAX_FEED_ITEMS_SHOWN}
          onChange={(maxItems) => update({ maxItems })}
          aria-label="Headlines shown"
        />
      </Field>
      <Switch
        label="Show summaries"
        description="Up to two lines of each article’s description under its headline."
        checked={value.showSummary}
        onCheckedChange={(showSummary) => update({ showSummary })}
      />
      <Switch
        label="Show feed names"
        description="Name the feed under each headline when the widget shows more than one."
        checked={value.showSource}
        onCheckedChange={(showSource) => update({ showSource })}
      />
    </div>
  );
}

interface FeedRowEditorProps {
  feed: FeedSource;
  first: boolean;
  last: boolean;
  onTitleChange(title: string): void;
  onRemove(): void;
  onMove(delta: number): void;
}

function FeedRowEditor({ feed, first, last, onTitleChange, onRemove, onMove }: FeedRowEditorProps) {
  const host = (() => {
    try {
      return new URL(feed.url).hostname.replace(/^www\./, '');
    } catch {
      return feed.url;
    }
  })();
  const name = feed.title || host;
  return (
    <li className={styles.row}>
      <div className={styles.fields}>
        <Input size="sm" value={feed.title} maxLength={120} placeholder={host} aria-label={`Name for ${feed.url}`} onChange={(e) => onTitleChange(e.currentTarget.value)} />
        <span className={styles.url} title={feed.url}>
          <Rss aria-hidden="true" />
          {feed.url}
        </span>
      </div>
      <div className={styles.actions}>
        <IconButton size="sm" icon={ArrowUp} aria-label={`Move ${name} up`} disabled={first} onClick={() => onMove(-1)} />
        <IconButton size="sm" icon={ArrowDown} aria-label={`Move ${name} down`} disabled={last} onClick={() => onMove(1)} />
        <IconButton size="sm" icon={X} aria-label={`Remove ${name}`} onClick={onRemove} />
      </div>
    </li>
  );
}

/** URL input that fetches the feed before adding it, so typos and pages without a feed show at once. */
function AddFeed({ existing, disabled, onAdd }: { existing: readonly string[]; disabled: boolean; onAdd(feed: FeedSource): void }) {
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const url = normalizeFeedInput(text);
    if (!isSafeHttpUrl(url)) {
      setError('Enter a web address, e.g. https://example.com/feed.xml');
      return;
    }
    if (existing.includes(url)) {
      setError('This feed is already in the list.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const feed = await client.fetchQuery(feedCheckQuery(url));
      // Store the feed's own address so later loads skip the page lookup.
      const feedUrl = isSafeHttpUrl(feed.feedUrl) ? feed.feedUrl : url;
      if (feedUrl !== url && existing.includes(feedUrl)) {
        setError('This feed is already in the list.');
        return;
      }
      if (feedUrl !== url) client.setQueryData(feedQuery(feedUrl).queryKey, { ...feed, url: feedUrl });
      onAdd({ url: feedUrl, title: '' });
      setText('');
    } catch (err) {
      setError(errorMessage(err, 'The feed could not be loaded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    // A div, not a nested <form>: the settings dialog may itself be a form.
    <div className={styles.add} data-settings-focus="feed-url">
      <Field label="Add a feed" hideLabel error={error ?? undefined}>
        <Input
          size="sm"
          type="url"
          inputMode="url"
          value={text}
          disabled={disabled || busy}
          placeholder={disabled ? 'Feed limit reached' : 'https://example.com/feed.xml'}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit(e);
          }}
        />
      </Field>
      <Button size="sm" icon={Plus} loading={busy} disabled={disabled || text.trim() === ''} onClick={(e) => void submit(e)}>
        Add
      </Button>
    </div>
  );
}
