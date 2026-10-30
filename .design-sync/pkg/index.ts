// Design-sync entry: the Portly UI kit, re-exported as-is. See .design-sync/NOTES.md.
// Build-time constants first (ES modules evaluate in import order), then global tokens and base
// styles in the same order as web/src/main.tsx.
import './env.ts';
import '../../web/src/styles/tokens.css';
import '../../web/src/styles/base.css';

export * from '../../web/src/ui/index.ts';

// Design-sync addition (not part of web/src/ui): see QueryProvider.tsx.
export { PortlyQueryProvider } from './QueryProvider.tsx';
