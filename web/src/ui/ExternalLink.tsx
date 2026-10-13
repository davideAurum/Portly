/**
 * ExternalLink (§4.4, §10.4): renders an anchor only for safe http(s) URLs (via safeHref);
 * anything else renders as plain text. External links open in a new tab with
 * `rel="noopener noreferrer"` unless `newTab` is false.
 */
import type { ComponentProps, ReactNode } from 'react';
import { ExternalLink as ExternalLinkIcon } from 'lucide-react';
import { linkProps } from '../lib/openUrl.ts';
import styles from './Display.module.css';

export interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target' | 'rel'> {
  href: string | null | undefined;
  children: ReactNode;
  /** Default true. */
  newTab?: boolean;
  /** Show a trailing ↗ icon. */
  showIcon?: boolean;
}

export function ExternalLink({ href, children, newTab = true, showIcon = false, className, ...rest }: ExternalLinkProps) {
  const props = linkProps(href, { newTab });
  if (!props) return <span className={className}>{children}</span>;
  return (
    <a {...rest} {...props} className={[styles.externalLink, className].filter(Boolean).join(' ')}>
      {children}
      {showIcon ? <ExternalLinkIcon aria-hidden="true" className={styles.externalIcon} /> : null}
      {props.target === '_blank' ? <span className="hb-visually-hidden"> (opens in a new tab)</span> : null}
    </a>
  );
}
