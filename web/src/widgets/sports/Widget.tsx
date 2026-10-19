/**
 * Sports widget: the favorite teams' games in three sections — Live (LIVE badge, clock and
 * situation, refreshed every 30 s), Upcoming (local day and time) and Final. A game row opens its
 * box score in a new tab (the preview before kick-off); live and upcoming games have a "Where to
 * watch" button listing their broadcasters with links to the official streaming services. Teams
 * whose games fail show a Retry row while the others keep working. Everything ESPN-supplied is
 * plain text rendered as React text; links go through `linkProps`.
 */
import { CircleAlert, ExternalLink, Radio, RefreshCw, Trophy, Tv } from 'lucide-react';
import { sportsLeague, type SportsCompetitor, type SportsGame } from '@portly/shared';
import { useTeamGames } from '../../api/sports.ts';
import { useWidgetFrame, WidgetActions } from '../../grid/WidgetContext.tsx';
import { useFormatters, type Formatters } from '../../lib/format.ts';
import { linkProps } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage } from '../../ui/toast.ts';
import type { WidgetProps } from '../types.ts';
import type { SportsConfig } from './index.ts';
import { TeamLogo } from './TeamLogo.tsx';
import { buildSections, gameLink, watchOptions, type GameRow } from './model.ts';
import styles from './Sports.module.css';

export default function SportsWidget({ config, size }: WidgetProps<SportsConfig>) {
  const frame = useWidgetFrame();
  const fmt = useFormatters();
  const now = useNow(60_000).getTime();
  const compact = size.h <= 3 || size.w <= 3;
  const teams = config.teams;
  const queries = useTeamGames(teams);
  const entries = teams.map((team, i) => ({ team, query: queries[i]! }));
  const sections = buildSections(entries.map((e) => ({ team: e.team, data: e.query.data })), config, now);

  if (teams.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        compact={compact}
        title="No teams yet"
        body="Pick your favorite teams to see live scores, results and upcoming games."
        action={
          frame.canOpenSettings ? (
            <Button size="sm" variant="primary" onClick={() => frame.openSettings({ focus: 'sports-team' })}>
              Choose teams
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
    if (failed.length === entries.length) return <ErrorState error={failed[0]!.query.error} onRetry={retryAll} compact={compact} />;
    return <SkeletonList rows={Math.min(5, Math.max(2, size.h - 2))} />;
  }

  const updatedAt = Math.min(...loaded.map((e) => e.query.dataUpdatedAt));
  const refreshError = loaded.find((e) => e.query.isError)?.query.error;
  const empty = sections.live.length + sections.upcoming.length + sections.final.length === 0;
  const rowProps = { fmt, now, showRecords: config.showRecords };

  return (
    <div className={styles.root}>
      <WidgetActions>
        <StaleIndicator updatedAt={updatedAt} error={refreshError} onRetry={retryAll} />
      </WidgetActions>
      {failed.length > 0 ? (
        <ul className={styles.notices} aria-label="Teams with problems">
          {failed.map(({ team, query }) => (
            <li key={`${team.league}:${team.id}`} className={styles.notice} data-testid="team-error">
              <CircleAlert className={styles.noticeIcon} aria-hidden="true" />
              <div className={styles.noticeText}>
                <strong>{team.name}</strong>
                <span className={styles.noticeMessage}>{errorMessage(query.error)}</span>
              </div>
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void query.refetch()}>
                Retry
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {empty ? (
        <div className={styles.fill}>
          <EmptyState icon={Trophy} compact={compact} title="No games right now" body="Nothing live, coming up soon or recently finished for these teams." />
        </div>
      ) : (
        <>
          <Section title="Live" rows={sections.live} {...rowProps} />
          <Section title="Upcoming" rows={sections.upcoming} {...rowProps} />
          <Section title="Final" rows={sections.final} {...rowProps} />
        </>
      )}
    </div>
  );
}

interface RowContext {
  fmt: Formatters;
  now: number;
  showRecords: boolean;
}

function Section({ title, rows, ...ctx }: { title: string; rows: GameRow[] } & RowContext) {
  if (rows.length === 0) return null;
  const id = `hb-sports-${title.toLowerCase()}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      <ul className={styles.list}>
        {rows.map((row) => (
          <GameRowView key={row.key} row={row} {...ctx} />
        ))}
      </ul>
    </section>
  );
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Tomorrow", "Yesterday" or a short date ("Sun, Oct 18"). */
export function dayLabel(date: string, now: number, fmt: Formatters): string {
  const ms = Date.parse(date);
  const day = 24 * 60 * 60 * 1000;
  const key = localDayKey(ms);
  if (key === localDayKey(now)) return 'Today';
  if (key === localDayKey(now + day)) return 'Tomorrow';
  if (key === localDayKey(now - day)) return 'Yesterday';
  return fmt.date(date, 'weekday-short');
}

function GameRowView({ row, fmt, now, showRecords }: { row: GameRow } & RowContext) {
  const { game } = row;
  const link = linkProps(gameLink(game));
  // Soccer lists the home side first; North American leagues list the visitors first.
  const soccer = sportsLeague(game.league)?.soccer === true;
  const [first, second] = soccer ? [game.home, game.away] : [game.away, game.home];
  const label = `${game.away.name} at ${game.home.name}`;

  const body = (
    <>
      <div className={styles.teams}>
        <TeamLine competitor={first} game={game} favorite={row.favorites.has(first.teamId)} showRecord={showRecords} />
        <TeamLine competitor={second} game={game} favorite={row.favorites.has(second.teamId)} showRecord={showRecords} />
      </div>
      <GameStatus game={game} fmt={fmt} now={now} />
      {game.situation || game.note ? <div className={styles.meta}>{[game.situation, game.note].filter(Boolean).join(' · ')}</div> : null}
    </>
  );

  return (
    <li className={styles.row} data-state={game.state}>
      {link ? (
        <a className={styles.game} {...link} title={game.state === 'pre' ? `${label} — game preview` : `${label} — box score`}>
          {body}
        </a>
      ) : (
        <div className={styles.game}>{body}</div>
      )}
      {/* Finished games keep the column so scores line up across sections. */}
      {game.state !== 'post' ? <WatchButton game={game} label={label} /> : <span className={styles.watchSpacer} aria-hidden="true" />}
    </li>
  );
}

function TeamLine({ competitor, game, favorite, showRecord }: { competitor: SportsCompetitor; game: SportsGame; favorite: boolean; showRecord: boolean }) {
  const lost = game.state === 'post' && competitor.winner === false;
  return (
    <div className={styles.team} data-favorite={favorite || undefined} data-winner={competitor.winner === true || undefined} data-lost={lost || undefined}>
      <TeamLogo src={competitor.logo} srcDark={competitor.logoDark} label={competitor.shortName} />
      <span className={styles.teamName}>
        <span className={styles.nameFull}>{competitor.shortName}</span>
        <span className={styles.nameAbbr}>{competitor.abbreviation || competitor.shortName}</span>
        {showRecord && competitor.record ? <span className={styles.record}>{competitor.record}</span> : null}
      </span>
      {competitor.score !== null ? <span className={styles.score}>{competitor.score}</span> : null}
    </div>
  );
}

function GameStatus({ game, fmt, now }: { game: SportsGame; fmt: Formatters; now: number }) {
  if (game.state === 'in') {
    return (
      <div className={styles.status}>
        <span className={styles.live}>
          <span className={styles.liveDot} aria-hidden="true" />
          Live
        </span>
        <span className={styles.clock}>{game.detail}</span>
      </div>
    );
  }
  if (game.state === 'post') {
    return (
      <div className={styles.status}>
        <span className={styles.final}>{game.detail || 'Final'}</span>
        <span className={styles.when}>{dayLabel(game.date, now, fmt)}</span>
      </div>
    );
  }
  return (
    <div className={styles.status}>
      <span className={styles.when}>{dayLabel(game.date, now, fmt)}</span>
      <span className={styles.clock}>{game.timeValid ? fmt.time(game.date) : 'TBD'}</span>
    </div>
  );
}

function WatchButton({ game, label }: { game: SportsGame; label: string }) {
  const options = watchOptions(game);
  const nothing = options.watch.length === 0 && options.radio.length === 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="sm" icon={Tv} className={styles.watchButton} aria-label={`Where to watch ${label}`} title="Where to watch" />
      </PopoverTrigger>
      <PopoverContent align="end" className={styles.watchPopover}>
        <p className={styles.watchTitle}>Where to watch</p>
        <p className={styles.watchGame}>{label}</p>
        {nothing ? <p className={styles.watchNote}>No broadcasters are listed for this game yet.</p> : null}
        {options.watch.length > 0 ? (
          <ul className={styles.watchList}>
            {options.watch.map(({ broadcast, service }) => {
              const link = service ? linkProps(service.url) : null;
              return (
                <li key={`${broadcast.name}|${broadcast.kind}`} className={styles.watchItem}>
                  <div className={styles.watchName}>
                    <strong>{broadcast.name}</strong>
                    <span className={styles.watchKind}>
                      {broadcast.kind === 'streaming' ? 'Streaming' : broadcast.kind === 'tv' ? 'TV' : 'Broadcast'}
                      {broadcast.market && broadcast.market !== 'National' ? ` · ${broadcast.market} market` : ''}
                    </span>
                  </div>
                  {service && link ? (
                    <a className={styles.watchLink} {...link}>
                      {service.label}
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {options.radio.length > 0 ? (
          <p className={styles.watchRadio}>
            <Radio aria-hidden="true" />
            Radio: {options.radio.map((b) => b.name).join(', ')}
          </p>
        ) : null}
        <p className={styles.watchNote}>Availability depends on your region and subscriptions.</p>
      </PopoverContent>
    </Popover>
  );
}
