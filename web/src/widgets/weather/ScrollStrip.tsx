/**
 * A horizontally scrolling strip (hourly / daily forecast) without a scrollbar eating the card's
 * height: the edges fade when there is more to see, a vertical mouse wheel scrolls it sideways
 * (until an end is reached, then the page scrolls as usual), and it is a focusable region so the
 * arrow keys scroll it too.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Widget.module.css';

export function ScrollStrip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft <= 1;
    const end = el.scrollLeft >= max - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const atStart = el.scrollLeft <= 0 && event.deltaY < 0;
      const atEnd = el.scrollLeft >= max - 1 && event.deltaY > 0;
      if (atStart || atEnd) return;
      event.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + event.deltaY));
      measure();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={ref}
      className={styles.hourly}
      role="region"
      aria-label={label}
      // Focusable so keyboard users can scroll it with the arrow keys.
      tabIndex={0}
      data-fade-start={edges.start ? undefined : 'true'}
      data-fade-end={edges.end ? undefined : 'true'}
      onScroll={measure}
    >
      {children}
    </div>
  );
}
