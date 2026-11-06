/**
 * Music widget (§10.8 Music, §10.7): a remote control for the music service connected in Settings →
 * Accounts. The sound plays on the user's own device, in the provider's app, so it carries on
 * while Portly's tab goes elsewhere.
 *
 * - It knows providers only through `MusicStatus.features` and {@link MUSIC_PROVIDER_INFO}: what a
 *   provider cannot do, or does not allow for this item right now, is hidden or disabled.
 * - Spotify's rules shape the layout: cover art is uncropped with nothing on top of it, the logo is
 *   always there, and the title, the art and the logo link back to Spotify.
 * - Sliders send one command when let go, not one per step of the drag.
 * - Not connected → CTA to Spotify in Settings → Accounts; an account to reconnect → the frame's
 *   usual Reconnect; refused by Spotify → its reason, with Retry.
 * - What the phone reports (docs/design/phone-now-playing.md) shows in {@link PhonePlayer}, with or
 *   without a music service. It is view-only, so it has no controls, and no Spotify logo.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  Monitor,
  Music as MusicIcon,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Smartphone,
  Speaker,
  Tv,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import type { MusicCommand, MusicDevice, MusicDeviceType, MusicItem, MusicPlayback, MusicStatus, PhonePlayback } from '@portly/shared';
import { isApiError } from '../../api/client.ts';
import { isMusicBlocked, useMusicCommand, useMusicDevices, useMusicPhone, useMusicStatus } from '../../api/music.ts';
import { WidgetActions } from '../../grid/WidgetContext.tsx';
import { linkProps, safeHref } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../../ui/Menu.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { errorMessage } from '../../ui/toast.ts';
import { Slider } from '../../ui/Toggles.tsx';
import type { WidgetProps } from '../types.ts';
import type { MusicConfig } from './index.ts';
import { artistLine, formatTime, livePosition, musicTier, nextRepeatMode, phoneIsShown, phoneItem, repeatLabel, type MusicTier } from './model.ts';
import { MUSIC_PROVIDER_INFO, PHONE_APP_NAMES, type MusicProviderInfo } from './providers.tsx';
import styles from './Music.module.css';

/** Spotify in Settings → Accounts: its connect dialog. */
export const SETTINGS_ROUTE = '#/settings/accounts?focus=spotify';

const DEVICE_ICONS: Readonly<Record<MusicDeviceType, LucideIcon>> = Object.freeze({
  computer: Monitor,
  phone: Smartphone,
  speaker: Speaker,
  tv: Tv,
  other: Radio,
});

type SendCommand = (command: MusicCommand) => void;

export default function MusicWidget({ config, size }: WidgetProps<MusicConfig>) {
  const accountId = config.accountId;
  const status = useMusicStatus(accountId);
  const phone = useMusicPhone();
  const tier = musicTier(size.h);
  const compact = tier === 'compact';
  const blocked = isMusicBlocked(status.error);

  const report = phone.data ?? null;
  if (report !== null && phoneIsShown(report, blocked ? null : (status.data?.playback ?? null), status.dataUpdatedAt)) {
    return (
      <div className={styles.root}>
        <WidgetActions>{phone.isError ? <StaleIndicator updatedAt={phone.dataUpdatedAt} error={phone.error} onRetry={() => void phone.refetch()} /> : null}</WidgetActions>
        <PhonePlayer phone={report} receivedAt={phone.dataUpdatedAt} tier={tier} />
      </div>
    );
  }

  // Setup problems can't fix themselves: show them instead of a stale player. They wait for the
  // phone's answer, or the connect card would flash up before an episode.
  if (status.data === undefined || blocked) {
    return (
      <div className={styles.root}>
        {status.isError && !phone.isPending ? (
          <MusicError error={status.error} onRetry={() => void status.refetch()} compact={compact} />
        ) : (
          <SkeletonList rows={compact ? 1 : 2} />
        )}
      </div>
    );
  }

  const provider = MUSIC_PROVIDER_INFO[status.data.provider];
  return (
    <div className={styles.root}>
      <WidgetActions>
        {status.isError ? <StaleIndicator updatedAt={status.dataUpdatedAt} error={status.error} onRetry={() => void status.refetch()} /> : null}
        <ProviderLink provider={provider} href={status.data.playback?.item?.url ?? null} />
      </WidgetActions>
      {status.data.playback === null ? (
        <Idle accountId={accountId} provider={provider} tier={tier} />
      ) : (
        <Player
          accountId={accountId}
          status={status.data}
          playback={status.data.playback}
          provider={provider}
          receivedAt={status.dataUpdatedAt}
          tier={tier}
          wide={size.w >= 4}
        />
      )}
    </div>
  );
}

function MusicError({ error, onRetry, compact }: { error: unknown; onRetry(): void; compact: boolean }) {
  if (isApiError(error, 'not_configured')) {
    const href = safeHref(SETTINGS_ROUTE);
    return (
      <div className={styles.state}>
        <EmptyState
          icon={MusicIcon}
          compact={compact}
          title="No music service connected"
          body="See what is playing and control it from here."
          action={
            href ? (
              <a className={styles.cta} href={href}>
                Connect Spotify
              </a>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (isApiError(error, 'forbidden')) {
    return (
      <div className={styles.state}>
        <EmptyState
          icon={MusicIcon}
          compact={compact}
          title="Spotify refused access"
          body={errorMessage(error)}
          action={
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className={styles.state}>
      <ErrorState error={error} onRetry={onRetry} compact={compact} />
    </div>
  );
}

/** The provider's logo, linking back to what is playing there. */
function ProviderLink({ provider, href }: { provider: MusicProviderInfo; href: string | null }) {
  const link = linkProps(href ?? provider.homeUrl);
  if (!link) return null;
  return (
    <a {...link} className={styles.providerLink} aria-label={`Open in ${provider.name}`} title={`Open in ${provider.name}`}>
      <provider.Mark className={styles.providerMark} />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Nothing playing
// ---------------------------------------------------------------------------

/** How many devices fit under "Nothing is playing" at each height. */
const IDLE_DEVICES: Readonly<Record<MusicTier, number>> = Object.freeze({ compact: 1, normal: 2, large: 4 });

function Idle({ accountId, provider, tier }: { accountId: string | null; provider: MusicProviderInfo; tier: MusicTier }) {
  const devices = useMusicDevices(accountId, true);
  const command = useMusicCommand(accountId);
  const usable = (devices.data ?? []).filter((device) => !device.restricted && device.id !== null);
  return (
    <div className={styles.state}>
      <EmptyState
        icon={MusicIcon}
        compact={tier !== 'large'}
        title="Nothing is playing"
        body={usable.length > 0 ? 'Pick where to play.' : `Open ${provider.name} on a device to start.`}
        action={
          usable.length > 0 ? (
            <ul className={styles.deviceChoices} aria-label="Devices">
              {usable.slice(0, IDLE_DEVICES[tier]).map((device) => (
                <li key={device.id}>
                  <Button size="sm" icon={DEVICE_ICONS[device.type]} onClick={() => command.mutate({ type: 'transfer', deviceId: device.id as string, play: true })}>
                    Play on {device.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <ExternalLink href={provider.homeUrl} showIcon>
              Open {provider.name}
            </ExternalLink>
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

interface PlayerProps {
  accountId: string | null;
  status: MusicStatus;
  playback: MusicPlayback;
  provider: MusicProviderInfo;
  /** When `playback` was received (the position moves on from there). */
  receivedAt: number;
  tier: MusicTier;
  /** Room for the volume beside the device. */
  wide: boolean;
}

function Player({ accountId, status, playback, provider, receivedAt, tier, wide }: PlayerProps) {
  const command = useMusicCommand(accountId);
  const send: SendCommand = (next) => command.mutate(next);
  const { features } = status;
  const { item, device, allowed } = playback;
  const compact = tier === 'compact';
  const showVolume = features.volume && !compact && wide && device?.volumePercent !== null && device !== null;

  return (
    <div className={styles.player} data-tier={tier}>
      <Artwork item={item} provider={provider} large={tier === 'large'} />
      <div className={styles.meta}>
        <Title item={item} provider={provider} />
        <p className={styles.artists}>{item === null ? 'Waiting for the next item' : artistLine(item)}</p>
        {tier === 'large' && item?.album ? <p className={styles.album}>{item.album}</p> : null}
      </div>
      <div className={styles.controls} role="group" aria-label="Playback">
        {features.shuffle && !compact ? (
          <IconButton
            icon={Shuffle}
            size="sm"
            aria-label={playback.shuffle ? 'Shuffle is on' : 'Shuffle is off'}
            pressed={playback.shuffle}
            disabled={!allowed.shuffle}
            onClick={() => send({ type: 'shuffle', on: !playback.shuffle })}
          />
        ) : null}
        <IconButton icon={SkipBack} size="sm" aria-label="Previous" disabled={!allowed.previous} onClick={() => send({ type: 'previous' })} />
        {playback.isPlaying ? (
          <IconButton icon={Pause} variant="primary" aria-label="Pause" disabled={!allowed.pause} onClick={() => send({ type: 'pause' })} />
        ) : (
          <IconButton icon={Play} variant="primary" aria-label="Play" disabled={!allowed.resume} onClick={() => send({ type: 'play' })} />
        )}
        <IconButton icon={SkipForward} size="sm" aria-label="Next" disabled={!allowed.next} onClick={() => send({ type: 'next' })} />
        {features.repeat && !compact ? (
          <IconButton
            icon={playback.repeat === 'track' ? Repeat1 : Repeat}
            size="sm"
            aria-label={repeatLabel(playback.repeat)}
            pressed={playback.repeat !== 'off'}
            disabled={!allowed.repeat}
            onClick={() => send({ type: 'repeat', mode: nextRepeatMode(playback.repeat) })}
          />
        ) : null}
        {features.devices && compact ? <DevicePicker accountId={accountId} playback={playback} send={send} iconOnly /> : null}
      </div>
      {!compact && item !== null ? (
        <SeekBar
          key={item.url ?? item.title}
          durationMs={item.durationMs}
          positionMs={playback.positionMs}
          isPlaying={playback.isPlaying}
          receivedAt={receivedAt}
          onSeek={features.seek && allowed.seek ? (positionMs) => send({ type: 'seek', positionMs }) : undefined}
        />
      ) : null}
      {!compact && (features.devices || showVolume) ? (
        <div className={styles.footer}>
          {features.devices ? <DevicePicker accountId={accountId} playback={playback} send={send} /> : null}
          {showVolume ? <VolumeSlider percent={device.volumePercent ?? 0} disabled={device.restricted} send={send} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playing on the phone
// ---------------------------------------------------------------------------

/** What the phone is playing: view-only, with the app and the state in words, since no button shows them. */
function PhonePlayer({ phone, receivedAt, tier }: { phone: PhonePlayback; receivedAt: number; tier: MusicTier }) {
  const provider = { name: PHONE_APP_NAMES[phone.app] };
  const item = phoneItem(phone);
  const isPlaying = phone.state === 'playing';
  // The state goes first: a narrow widget cuts the end of this line off.
  const credit = `${isPlaying ? '' : 'Paused · '}${provider.name}, on your phone`;
  return (
    <div className={styles.player} data-tier={tier}>
      <Artwork item={item} provider={provider} large={tier === 'large'} />
      <div className={styles.meta}>
        <Title item={item} provider={provider} />
        {phone.show === null ? null : <p className={styles.artists}>{phone.show}</p>}
      </div>
      <p className={styles.credit}>
        <Smartphone aria-hidden="true" className={styles.creditIcon} />
        <span className={styles.creditText} title={credit}>
          {credit}
        </span>
      </p>
      {tier !== 'compact' && phone.durationMs !== null ? (
        <SeekBar durationMs={phone.durationMs} positionMs={phone.positionMs} isPlaying={isPlaying} speed={phone.speed} receivedAt={receivedAt} />
      ) : null}
    </div>
  );
}

function Artwork({ item, provider, large }: { item: MusicItem | null; provider: Pick<MusicProviderInfo, 'name'>; large: boolean }) {
  // The failed address, not a flag: the next item's art gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const art = item?.artworkUrl ?? null;
  const image =
    art !== null && art !== failed ? (
      <img className={styles.art} src={art} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(art)} />
    ) : (
      <span className={styles.artPlaceholder}>
        <MusicIcon aria-hidden="true" />
      </span>
    );
  const link = linkProps(item?.url);
  const frame = (content: ReactNode) => (
    <span className={styles.artFrame} data-large={large ? 'true' : undefined}>
      {content}
    </span>
  );
  if (!link || item === null) return frame(image);
  return (
    <a {...link} className={styles.artLink} aria-label={`Open ${item.title} in ${provider.name}`}>
      {frame(image)}
    </a>
  );
}

function Title({ item, provider }: { item: MusicItem | null; provider: Pick<MusicProviderInfo, 'name'> }) {
  if (item === null) return <p className={styles.title}>{provider.name}</p>;
  const link = linkProps(item.url);
  if (!link) return <p className={styles.title} title={item.title}>{item.title}</p>;
  return (
    <a {...link} className={styles.title} title={item.title}>
      {item.title}
    </a>
  );
}

/** A slider that sends one value when let go: by pointer, by key or by leaving it. */
function CommitSlider({ value, onCommit, ...slider }: { value: number; onCommit(value: number): void; max: number; step?: number; format(value: number): string; disabled: boolean; 'aria-label': string }) {
  const [draft, setDraft] = useState<number | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    onCommit(draft);
  };
  // On the window: a drag often ends with the pointer off the slider.
  useEffect(() => {
    if (draft === null) return;
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
    return () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
    };
  });
  return (
    <div className={styles.slider} onKeyUp={commit} onBlur={commit}>
      <Slider {...slider} min={0} value={draft ?? value} onChange={setDraft} />
    </div>
  );
}

interface SeekBarProps {
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  /** The playback speed, where it is known. */
  speed?: number;
  receivedAt: number;
  /** Without it the bar only shows the position. */
  onSeek?: ((positionMs: number) => void) | undefined;
}

function SeekBar({ durationMs, positionMs, isPlaying, speed, receivedAt, onSeek }: SeekBarProps) {
  const now = useNow(1000).getTime();
  const position = livePosition(positionMs, isPlaying, receivedAt, now, durationMs, speed);
  const duration = formatTime(durationMs);
  return (
    <CommitSlider
      aria-label="Position"
      value={Math.floor(position / 1000)}
      max={Math.max(1, Math.floor(durationMs / 1000))}
      format={(seconds) => `${formatTime(seconds * 1000)} / ${duration}`}
      disabled={onSeek === undefined}
      onCommit={(seconds) => onSeek?.(seconds * 1000)}
    />
  );
}

function VolumeSlider({ percent, disabled, send }: { percent: number; disabled: boolean; send: SendCommand }) {
  return (
    <div className={styles.volume}>
      <Volume2 aria-hidden="true" className={styles.volumeIcon} />
      <CommitSlider
        aria-label="Volume"
        value={percent}
        max={100}
        step={5}
        format={(value) => `${value}%`}
        disabled={disabled}
        onCommit={(value) => send({ type: 'volume', percent: value })}
      />
    </div>
  );
}

function DevicePicker({ accountId, playback, send, iconOnly = false }: { accountId: string | null; playback: MusicPlayback; send: SendCommand; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const devices = useMusicDevices(accountId, open);
  const current = playback.device;
  const Icon = current === null ? Radio : DEVICE_ICONS[current.type];
  const name = current?.name ?? 'Choose a device';
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        {iconOnly ? (
          <IconButton icon={Icon} size="sm" tooltip={false} aria-label={`Playing on ${name}. Change device`} />
        ) : (
          <Button size="sm" variant="ghost" icon={Icon} className={styles.deviceButton} aria-label={`Playing on ${name}. Change device`}>
            <span className={styles.deviceName}>{name}</span>
          </Button>
        )}
      </MenuTrigger>
      <MenuContent align="start">
        <MenuLabel>Play on</MenuLabel>
        {devices.isPending ? <MenuItem disabled>Looking for devices…</MenuItem> : null}
        {devices.isError ? <MenuItem disabled>{errorMessage(devices.error, 'Devices could not be loaded.')}</MenuItem> : null}
        {devices.data?.length === 0 ? <MenuItem disabled>No other device is online</MenuItem> : null}
        {devices.data?.map((device) => <DeviceItem key={device.id} device={device} playback={playback} send={send} />)}
      </MenuContent>
    </Menu>
  );
}

function DeviceItem({ device, playback, send }: { device: MusicDevice; playback: MusicPlayback; send: SendCommand }) {
  const Icon = DEVICE_ICONS[device.type];
  return (
    <MenuItem
      icon={<Icon aria-hidden="true" />}
      hint={device.active ? <Check aria-label="Playing here" /> : undefined}
      disabled={device.restricted || device.id === null}
      onSelect={() => {
        if (device.id !== null && !device.active) send({ type: 'transfer', deviceId: device.id, play: playback.isPlaying });
      }}
    >
      {device.name}
    </MenuItem>
  );
}
