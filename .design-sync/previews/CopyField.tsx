import { CopyField, Field } from '@portly/ui';
import type { CSSProperties, ReactNode } from 'react';

// CopyField shows read-only values in settings cards on a glass panel.
const panel: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)',
  padding: 'var(--hb-space-4)', borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};
const Panel = ({ children }: { children: ReactNode }) => <div style={panel}>{children}</div>;

export const RedirectUri = () => (
  <Panel>
    <Field label="Redirect URI" help="Paste this into your OAuth app's list of allowed redirect URIs.">
      <CopyField value="http://127.0.0.1:5757/api/oauth/google/callback" label="Redirect URI" />
    </Field>
  </Panel>
);

export const FolderPaths = () => (
  <Panel>
    <Field label="Data folder">
      <CopyField value={'C:\\Users\\you\\AppData\\Local\\Portly\\data'} label="Data folder path" />
    </Field>
    <Field label="Log file">
      <CopyField value={'C:\\Users\\you\\AppData\\Local\\Portly\\logs\\server.log'} label="Log file path" />
    </Field>
  </Panel>
);

export const PlainText = () => (
  <Panel>
    <Field label="Pairing name" help="Shown on the main PC when this browser asks to connect.">
      <CopyField value="Living room laptop" label="Pairing name" monospace={false} />
    </Field>
  </Panel>
);

export const Standalone = () => (
  <Panel>
    <CopyField value="https://<user>.github.io/portly/" label="Pages address" />
  </Panel>
);
