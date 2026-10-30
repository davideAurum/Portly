import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@portly/ui';
import { RefreshCw } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';

const panel: CSSProperties = {
  display: 'grid', gap: 'var(--hb-space-3)', width: 460,
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;
const text: CSSProperties = { fontSize: 'var(--hb-text-sm)', color: 'var(--hb-text-muted)', margin: 0 };
const list: CSSProperties = { display: 'grid', gap: 'var(--hb-space-2)', margin: 0, padding: 0, listStyle: 'none', fontSize: 'var(--hb-text-sm)' };
const line: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between' };

export const Diagnostics = () => {
  const [tab, setTab] = useState('overview');
  return (
    <Panel>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Diagnostics">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="browser">This browser</TabsTrigger>
          <TabsTrigger value="log">Server log</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <ul style={list}>
            <li style={line}>Portly on this PC <Badge tone="success" dot>Running</Badge></li>
            <li style={line}>Outlook.com mail <Badge tone="success" dot>Synced 4 min ago</Badge></li>
            <li style={line}>Weather <Badge tone="warning" dot>Last try failed</Badge></li>
          </ul>
        </TabsContent>
        <TabsContent value="connections"><p style={text}>3 accounts connected.</p></TabsContent>
        <TabsContent value="browser"><p style={text}>No failed requests in this browser.</p></TabsContent>
        <TabsContent value="log"><p style={text}>The server log is empty.</p></TabsContent>
      </Tabs>
    </Panel>
  );
};

export const NewsFeeds = () => (
  <Panel>
    <Tabs defaultValue="tech">
      <TabsList aria-label="News feeds">
        <TabsTrigger value="all">All stories</TabsTrigger>
        <TabsTrigger value="tech">Tech</TabsTrigger>
        <TabsTrigger value="local">Local</TabsTrigger>
        <TabsTrigger value="saved" disabled>Saved</TabsTrigger>
      </TabsList>
      <TabsContent value="all"><p style={text}>42 stories from 6 feeds.</p></TabsContent>
      <TabsContent value="tech">
        <ul style={list}>
          <li>Browser makers agree on a new extension API</li>
          <li>The quiet return of the home page</li>
          <li>Why your laptop fan spins at idle</li>
        </ul>
      </TabsContent>
      <TabsContent value="local"><p style={text}>No new stories.</p></TabsContent>
    </Tabs>
    <div><Button size="sm" variant="ghost" icon={RefreshCw}>Refresh feeds</Button></div>
  </Panel>
);

export const Forecast = () => (
  <Panel>
    <Tabs defaultValue="week">
      <TabsList aria-label="Forecast range">
        <TabsTrigger value="today">Today</TabsTrigger>
        <TabsTrigger value="week">Next 5 days</TabsTrigger>
      </TabsList>
      <TabsContent value="today"><p style={text}>Lisbon: 21°, partly cloudy. High 24°, low 15°.</p></TabsContent>
      <TabsContent value="week">
        <ul style={list}>
          <li style={line}>Thursday <span>24° / 15°, sunny</span></li>
          <li style={line}>Friday <span>22° / 14°, partly cloudy</span></li>
          <li style={line}>Saturday <span>18° / 13°, rain</span></li>
        </ul>
      </TabsContent>
    </Tabs>
  </Panel>
);
