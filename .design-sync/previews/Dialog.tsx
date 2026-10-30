import { Button, Dialog, Field, Input, Select } from '@portly/ui';
import { Rss } from 'lucide-react';

// Rendered open (controlled `open`), so the card shows the dialog surface over its overlay.
export const AddFeed = () => (
  <Dialog
    open
    onOpenChange={() => {}}
    title="Add a news feed"
    description="Portly checks the feed every 30 minutes and shows new stories in the News widget."
    footer={
      <>
        <Button variant="ghost">Cancel</Button>
        <Button variant="primary" icon={Rss}>Add feed</Button>
      </>
    }
  >
    <div style={{ display: 'grid', gap: 'var(--hb-space-4)' }}>
      <Field label="Feed address" required>
        <Input type="url" defaultValue="https://www.theverge.com/rss/index.xml" />
      </Field>
      <Field label="Show in">
        <Select defaultValue="news">
          <option value="news">News (main page)</option>
          <option value="tech">Tech reading</option>
        </Select>
      </Field>
    </div>
  </Dialog>
);

export const SideSheet = () => (
  <Dialog
    open
    onOpenChange={() => {}}
    placement="side"
    title="Weather settings"
    description="Changes preview on your dashboard as you make them."
    footer={
      <>
        <Button variant="ghost">Cancel</Button>
        <Button variant="primary">Save</Button>
      </>
    }
  >
    <div style={{ display: 'grid', gap: 'var(--hb-space-4)' }}>
      <Field label="Location" help="City name or coordinates.">
        <Input defaultValue="Lisbon, Portugal" />
      </Field>
      <Field label="Forecast">
        <Select defaultValue="5">
          <option value="3">3 days</option>
          <option value="5">5 days</option>
          <option value="7">7 days</option>
        </Select>
      </Field>
    </div>
  </Dialog>
);
