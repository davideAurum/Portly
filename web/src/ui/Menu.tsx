/**
 * Menu (§10.4): a styled dropdown menu over Radix (keyboard navigation, typeahead, focus return).
 * Compose it like Radix: `<Menu><MenuTrigger asChild>…</MenuTrigger><MenuContent>…</MenuContent></Menu>`.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import styles from './Popover.module.css';

function cx(...names: (string | undefined | false)[]): string {
  return names.filter(Boolean).join(' ');
}

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuSub = DropdownMenu.Sub;

export function MenuContent({ className, children, sideOffset = 6, align = 'start', ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={12}
        {...props}
        className={cx(styles.surface, styles.menu, className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof DropdownMenu.Item> {
  icon?: ReactNode;
  /** Right-aligned hint (e.g. a shortcut). */
  hint?: ReactNode;
  destructive?: boolean;
}

export function MenuItem({ className, icon, hint, destructive, children, ...props }: MenuItemProps) {
  return (
    <DropdownMenu.Item {...props} className={cx(styles.item, className)} data-destructive={destructive ? 'true' : undefined}>
      {icon ? <span className={styles.itemIcon}>{icon}</span> : null}
      <span className={styles.itemLabel}>{children}</span>
      {hint ? <span className={styles.itemHint}>{hint}</span> : null}
    </DropdownMenu.Item>
  );
}

export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem {...props} className={cx(styles.item, className)}>
      <span className={styles.itemIcon}>
        <DropdownMenu.ItemIndicator>
          <Check aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className={styles.itemLabel}>{children}</span>
    </DropdownMenu.RadioItem>
  );
}

export function MenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem {...props} className={cx(styles.item, className)}>
      <span className={styles.itemIcon}>
        <DropdownMenu.ItemIndicator>
          <Check aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className={styles.itemLabel}>{children}</span>
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className={styles.separator} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className={styles.menuLabel}>{children}</DropdownMenu.Label>;
}

export function MenuSubTrigger({ className, children, icon, ...props }: ComponentProps<typeof DropdownMenu.SubTrigger> & { icon?: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger {...props} className={cx(styles.item, className)}>
      {icon ? <span className={styles.itemIcon}>{icon}</span> : null}
      <span className={styles.itemLabel}>{children}</span>
      <ChevronRight aria-hidden="true" className={styles.subIcon} />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({ className, ...props }: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent sideOffset={4} {...props} className={cx(styles.surface, styles.menu, className)} />
    </DropdownMenu.Portal>
  );
}
