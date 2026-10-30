// A React Query client for designs and previews. A few kit components read server state through
// React Query hooks (ErrorState and ReconnectButton call useAccount), which throw without a
// QueryClientProvider. The app gets one from app/providers.tsx; this is the design-sync stand-in.
// It lives in the bundle so it shares the bundle's copy of @tanstack/react-query.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function PortlyQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
