import {
  Button, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem,
  MenuSeparator, MenuTrigger,
} from '@portly/ui';
import { Copy, Pencil, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';

// Open by default so the card shows the menu surface; modal={false} keeps the page scrollable.
export const WidgetActions = () => (
  <div style={{ padding: 'var(--hb-space-4)', minHeight: 280 }}>
    <Menu defaultOpen modal={false}>
      <MenuTrigger asChild>
        <Button icon={Settings}>Widget options</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Weather</MenuLabel>
        <MenuItem icon={<Pencil />} hint="E">Edit settings</MenuItem>
        <MenuItem icon={<Copy />}>Duplicate</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} destructive>Remove from page</MenuItem>
      </MenuContent>
    </Menu>
  </div>
);

export const Choices = () => {
  const [units, setUnits] = useState('metric');
  const [showFeels, setShowFeels] = useState(true);
  return (
    <div style={{ padding: 'var(--hb-space-4)', minHeight: 280 }}>
      <Menu defaultOpen modal={false}>
        <MenuTrigger asChild>
          <Button>Display</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Units</MenuLabel>
          <MenuRadioGroup value={units} onValueChange={setUnits}>
            <MenuRadioItem value="metric">Celsius, km/h</MenuRadioItem>
            <MenuRadioItem value="imperial">Fahrenheit, mph</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuCheckboxItem checked={showFeels} onCheckedChange={(v) => setShowFeels(v === true)}>
            Show "feels like"
          </MenuCheckboxItem>
        </MenuContent>
      </Menu>
    </div>
  );
};
