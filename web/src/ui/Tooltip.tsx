/** Tooltip (§10.4) on Radix: shows on hover and keyboard focus; never the only label. */
import type { ReactElement, ReactNode } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  /** The trigger; must accept a ref and forward DOM props (buttons, links). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayMs?: number;
}

export function Tooltip({ content, children, side = 'bottom', delayMs = 450 }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayMs} skipDelayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={styles.content} side={side} sideOffset={6} collisionPadding={8}>
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
