import { Badge, Button, Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@portly/ui';
import { CalendarClock, MapPin, Video } from 'lucide-react';
import type { CSSProperties } from 'react';

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 'var(--hb-space-2)', fontSize: 'var(--hb-text-sm)' };
const muted: CSSProperties = { ...row, color: 'var(--hb-text-muted)' };

// Open by default (Radix `defaultOpen`; popovers are non-modal) so the card shows the surface.
export const EventDetails = () => (
  <div style={{ padding: 'var(--hb-space-4)', minHeight: 280 }}>
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button icon={CalendarClock}>Team stand-up, 09:30</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Event details" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div style={{ display: 'grid', gap: 'var(--hb-space-3)', width: 300 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 'var(--hb-text-md)' }}>Team stand-up</strong>
            <span style={muted}>Wednesday, 15 May, 09:30 to 09:45</span>
          </div>
          <div style={row}><MapPin size={16} aria-hidden="true" /> Room 4B and online</div>
          <div style={row}><Badge>Work calendar</Badge></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--hb-space-2)' }}>
            <PopoverClose asChild>
              <Button size="sm" variant="ghost">Close</Button>
            </PopoverClose>
            <Button size="sm" variant="primary" icon={Video}>Join call</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </div>
);
