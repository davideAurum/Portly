/** Tabs (§10.4): styled Radix tabs (roles, panels, arrow-key navigation). */
import type { ComponentProps } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import styles from './Popover.module.css';

function cx(...names: (string | undefined | false)[]): string {
  return names.filter(Boolean).join(' ');
}

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List {...props} className={cx(styles.tabsList, className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger {...props} className={cx(styles.tab, className)} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content {...props} className={cx(styles.tabContent, className)} />;
}
