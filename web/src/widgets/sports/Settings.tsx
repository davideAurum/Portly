/**
 * Sports widget settings: pick favorite teams (a league, then a searchable list of its teams from
 * ESPN), reorder and remove them; how many finished and upcoming games to show per team, how far
 * ahead to look, and season records. Changes go to the dialog draft.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Search, X } from 'lucide-react';
import { SPORTS_LEAGUES, sportsLeague, type SportsTeam } from '@homebase/shared';
import { useSportsTeams } from '../../api/sports.ts';
import { IconButton } from '../../ui/Button.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select } from '../../ui/Input.tsx';
import { Skeleton } from '../../ui/Skeleton.tsx';
import { Slider, Switch } from '../../ui/Toggles.tsx';
import { errorMessage } from '../../ui/toast.ts';
import type { WidgetSettingsProps } from '../types.ts';
import { MAX_FAVORITE_TEAMS, MAX_GAMES_PER_KIND, MAX_UPCOMING_DAYS, type FavoriteTeam, type SportsConfig } from './index.ts';
import { TeamLogo } from './TeamLogo.tsx';
import styles from './Settings.module.css';

const LEAGUE_OPTIONS = SPORTS_LEAGUES.map((l) => ({ value: l.id, label: l.name }));
/** Rows shown in the team list before the user narrows it down. */
const MAX_TEAM_RESULTS = 60;

export function favoriteFromTeam(team: SportsTeam): FavoriteTeam {
  return { league: team.league, id: team.id, name: team.name, abbreviation: team.abbreviation, logo: team.logo };
}

export default function SportsSettings({ value, onChange }: WidgetSettingsProps<SportsConfig>) {
  const update = (patch: Partial<SportsConfig>) => onChange({ ...value, ...patch });
  const teams = value.teams;
  const setTeams = (next: FavoriteTeam[]) => update({ teams: next });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= teams.length) return;
    const next = [...teams];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setTeams(next);
  };
  const games = (n: number) => (n === 0 ? 'None' : String(n));

  return (
    <div className={styles.stack}>
      <div className={styles.group} role="group" aria-labelledby="hb-sports-teams">
        <div className={styles.groupHeader}>
          <p id="hb-sports-teams" className={styles.groupLabel}>
            Favorite teams
          </p>
          <span className={styles.count}>
            {teams.length} / {MAX_FAVORITE_TEAMS}
          </span>
        </div>
        {teams.length > 0 ? (
          <ul className={styles.list} aria-label="Favorite teams">
            {teams.map((team, index) => (
              <li key={`${team.league}:${team.id}`} className={styles.row}>
                <TeamLogo src={team.logo} label={team.name} size={24} />
                <div className={styles.fields}>
                  <span className={styles.name}>{team.name}</span>
                  <span className={styles.league}>{sportsLeague(team.league)?.name ?? team.league}</span>
                </div>
                <div className={styles.actions}>
                  <IconButton size="sm" icon={ArrowUp} aria-label={`Move ${team.name} up`} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton size="sm" icon={ArrowDown} aria-label={`Move ${team.name} down`} disabled={index === teams.length - 1} onClick={() => move(index, 1)} />
                  <IconButton size="sm" icon={X} aria-label={`Remove ${team.name}`} onClick={() => setTeams(teams.filter((_, i) => i !== index))} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>Choose a league, then add your teams.</p>
        )}
        <TeamPicker
          chosen={teams}
          full={teams.length >= MAX_FAVORITE_TEAMS}
          onAdd={(team) => setTeams([...teams, favoriteFromTeam(team)])}
          onRemove={(team) => setTeams(teams.filter((t) => !(t.league === team.league && t.id === team.id)))}
        />
      </div>

      <Field label="Recent results per team">
        <Slider value={value.recentGames} min={0} max={MAX_GAMES_PER_KIND} format={games} onChange={(recentGames) => update({ recentGames })} aria-label="Recent results per team" />
      </Field>
      <Field label="Upcoming games per team">
        <Slider value={value.upcomingGames} min={0} max={MAX_GAMES_PER_KIND} format={games} onChange={(upcomingGames) => update({ upcomingGames })} aria-label="Upcoming games per team" />
      </Field>
      <Field label="Look ahead" help="Upcoming games further away than this are not shown.">
        <Slider
          value={value.upcomingDays}
          min={1}
          max={MAX_UPCOMING_DAYS}
          format={(d) => (d === 1 ? '1 day' : `${d} days`)}
          onChange={(upcomingDays) => update({ upcomingDays })}
          aria-label="Look ahead"
        />
      </Field>
      <Switch
        label="Show records"
        description="Each team’s win–loss record next to its name."
        checked={value.showRecords}
        onCheckedChange={(showRecords) => update({ showRecords })}
      />
    </div>
  );
}

interface TeamPickerProps {
  chosen: readonly FavoriteTeam[];
  full: boolean;
  onAdd(team: SportsTeam): void;
  onRemove(team: SportsTeam): void;
}

function TeamPicker({ chosen, full, onAdd, onRemove }: TeamPickerProps) {
  const [league, setLeague] = useState(chosen.at(-1)?.league ?? SPORTS_LEAGUES[0]!.id);
  const [query, setQuery] = useState('');
  const teamsQuery = useSportsTeams(league);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (teamsQuery.data ?? []).filter(
    (t) => needle === '' || t.name.toLocaleLowerCase().includes(needle) || t.abbreviation.toLocaleLowerCase() === needle,
  );
  const isChosen = (team: SportsTeam) => chosen.some((c) => c.league === team.league && c.id === team.id);

  return (
    <div className={styles.picker} data-settings-focus="sports-team">
      <div className={styles.pickerControls}>
        <Field label="League" hideLabel>
          <Select size="sm" value={league} options={LEAGUE_OPTIONS} onChange={(e) => setLeague(e.currentTarget.value)} />
        </Field>
        <Field label="Find a team" hideLabel>
          <Input size="sm" type="search" leading={<Search aria-hidden="true" />} value={query} placeholder="Find a team" onChange={(e) => setQuery(e.currentTarget.value)} />
        </Field>
      </div>
      {teamsQuery.isPending ? (
        <div className={styles.results} aria-busy="true">
          <Skeleton height={28} />
          <Skeleton height={28} />
          <Skeleton height={28} />
        </div>
      ) : teamsQuery.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(teamsQuery.error, 'The teams could not be loaded.')}
        </p>
      ) : matches.length === 0 ? (
        <p className={styles.note}>No team matches “{query.trim()}”.</p>
      ) : (
        <ul className={styles.results} aria-label={`${sportsLeague(league)?.name ?? ''} teams`}>
          {matches.slice(0, MAX_TEAM_RESULTS).map((team) => {
            const added = isChosen(team);
            return (
              <li key={team.id}>
                <button
                  type="button"
                  className={styles.result}
                  aria-pressed={added}
                  disabled={!added && full}
                  onClick={() => (added ? onRemove(team) : onAdd(team))}
                >
                  <TeamLogo src={team.logo} srcDark={team.logoDark} label={team.shortName} />
                  <span className={styles.resultName}>{team.name}</span>
                  {added ? <Check className={styles.resultIcon} aria-label="Added" /> : <Plus className={styles.resultIcon} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          {matches.length > MAX_TEAM_RESULTS ? <li className={styles.more}>{matches.length - MAX_TEAM_RESULTS} more — type to narrow the list</li> : null}
        </ul>
      )}
    </div>
  );
}
