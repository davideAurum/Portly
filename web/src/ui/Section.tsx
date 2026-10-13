/**
 * Building blocks for settings pages (shared with the feature-owned sections): a titled card
 * with optional actions, a form footer with Save/Reset and a "saved" status, and a description
 * list for read-only facts.
 */
import type { ReactNode } from 'react';
import styles from './Section.module.css';

export interface SettingsCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned header content (buttons, badges). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Visual emphasis for dangerous operations. */
  tone?: 'default' | 'danger';
  id?: string;
}

export function SettingsCard({ title, description, actions, children, tone = 'default', id }: SettingsCardProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={styles.card} data-tone={tone} id={id} aria-labelledby={headingId}>
      <header className={styles.cardHeader}>
        <div className={styles.cardTitles}>
          <h2 id={headingId} className={styles.cardTitle}>
            {title}
          </h2>
          {description ? <p className={styles.cardDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.cardActions}>{actions}</div> : null}
      </header>
      {children ? <div className={styles.cardBody}>{children}</div> : null}
    </section>
  );
}

/** Right-aligned form buttons with an optional status message on the left. */
export function FormFooter({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.footer}>
      <p className={styles.footerStatus} role="status">
        {status}
      </p>
      <div className={styles.footerButtons}>{children}</div>
    </div>
  );
}

/** Two-column grid of fields that collapses to one column on narrow screens. */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className={styles.fieldGrid}>{children}</div>;
}

export interface FactListProps {
  items: { label: ReactNode; value: ReactNode }[];
}

/** Read-only label/value pairs (e.g. the About page). */
export function FactList({ items }: FactListProps) {
  return (
    <dl className={styles.facts}>
      {items.map((item, index) => (
        <div key={index} className={styles.fact}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
