/**
 * Popover (§10.4): a styled wrapper over the Radix primitive. Compose it like Radix:
 * `<Popover><PopoverTrigger asChild>…</PopoverTrigger><PopoverContent>…</PopoverContent></Popover>`.
 */
import type { ComponentProps } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import styles from './Popover.module.css';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;
export const PopoverAnchor = RadixPopover.Anchor;

export function PopoverContent({ className, children, sideOffset = 6, ...props }: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={12}
        {...props}
        className={[styles.surface, styles.popover, className].filter(Boolean).join(' ')}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
