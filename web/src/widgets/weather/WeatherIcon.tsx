/**
 * WMO weather code → lucide icon (day/night variants from the shared WMO map, §7a), tinted by
 * condition with theme tokens only.
 */
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudMoon,
  CloudMoonRain,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  CloudSunRain,
  Moon,
  Snowflake,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { weatherCodeInfo, type WeatherIconName } from '@homebase/shared';
import styles from './Widget.module.css';

export const WEATHER_ICONS: Record<WeatherIconName, LucideIcon> = {
  Sun,
  Moon,
  CloudSun,
  CloudMoon,
  Cloud,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudRainWind,
  CloudSunRain,
  CloudMoonRain,
  CloudSnow,
  Snowflake,
  CloudHail,
  CloudLightning,
};

export type WeatherTone = 'sun' | 'moon' | 'partly' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

const TONES: Record<WeatherIconName, WeatherTone> = {
  Sun: 'sun',
  Moon: 'moon',
  CloudSun: 'partly',
  CloudMoon: 'moon',
  Cloud: 'cloud',
  CloudFog: 'fog',
  CloudDrizzle: 'rain',
  CloudRain: 'rain',
  CloudRainWind: 'rain',
  CloudSunRain: 'rain',
  CloudMoonRain: 'rain',
  CloudSnow: 'snow',
  Snowflake: 'snow',
  CloudHail: 'snow',
  CloudLightning: 'storm',
};

export interface WeatherIconProps {
  code: number;
  isDay?: boolean;
  className?: string;
  /** Accessible label; decorative (aria-hidden) when omitted. */
  label?: string;
}

export function WeatherIcon({ code, isDay = true, className, label }: WeatherIconProps) {
  const info = weatherCodeInfo(code, isDay);
  const Icon = WEATHER_ICONS[info.icon];
  return (
    <Icon
      className={[styles.weatherIcon, className].filter(Boolean).join(' ')}
      data-tone={TONES[info.icon]}
      data-icon={info.icon}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      strokeWidth={1.75}
    />
  );
}
