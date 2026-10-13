/**
 * The "Verbose" badge next to Diagnostics in the settings navigation, while the server logs
 * verbosely (`useVerboseLogging`): a reminder that more is being written than usual.
 */
import { Badge } from '../../ui/Badge.tsx';
import { useVerboseLogging } from './hooks.ts';
import styles from './Diagnostics.module.css';

export function VerboseNavBadge() {
  if (!useVerboseLogging()) return null;
  return (
    <span className={styles.navBadge}>
      <Badge tone="warning" title="Verbose logging is on">
        Verbose
      </Badge>
    </span>
  );
}
