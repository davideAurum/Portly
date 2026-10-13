/**
 * RelativeTime (§10.4): "5 min ago" in the user's locale, refreshed every 30 s, with the full date
 * and time as a tooltip and machine-readable `dateTime`.
 */
import { useFormatters, toDate, type DateInput } from '../lib/format.ts';
import { useNow } from '../lib/useNow.ts';

export interface RelativeTimeProps {
  date: DateInput;
  className?: string;
}

export function RelativeTime({ date, className }: RelativeTimeProps) {
  const now = useNow(30_000);
  const fmt = useFormatters();
  const value = toDate(date);
  if (Number.isNaN(value.getTime())) return null;
  return (
    <time className={className} dateTime={value.toISOString()} title={fmt.dateTime(value)}>
      {fmt.relative(value, now)}
    </time>
  );
}
