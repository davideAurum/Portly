/** What each connection offers on which page load: launch pad sync only where the data lives in this browser. */
import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../../../capabilities.ts';
import { connectionServices, defaultPicked } from './connections.ts';

const services = (id: Parameters<typeof connectionServices>[0], caps: ReturnType<typeof capabilitiesFor>) => connectionServices(id, caps).map((s) => s.capability);

describe('connectionServices', () => {
  it('offers launch pad sync on Microsoft connections on the browser backend only', () => {
    expect(services('microsoft', capabilitiesFor(true, 'browser'))).toEqual(['calendar', 'launchpadSync']);
    expect(services('microsoft', capabilitiesFor(true, 'server'))).toEqual(['calendar', 'mail']);
    expect(services('microsoft', capabilitiesFor(false, 'server'))).toEqual(['calendar', 'mail']);
  });

  it('never offers it on another connection', () => {
    for (const caps of [capabilitiesFor(true, 'browser'), capabilitiesFor(false, 'server')]) {
      for (const id of ['google', 'yahoo', 'other'] as const) expect(services(id, caps)).not.toContain('launchpadSync');
    }
  });

  it('starts a connect dialog with every service ticked but launch pad sync', () => {
    expect(defaultPicked(connectionServices('microsoft', capabilitiesFor(true, 'browser')))).toEqual(['calendar']);
    expect(defaultPicked(connectionServices('microsoft', capabilitiesFor(false, 'server')))).toEqual(['calendar', 'mail']);
  });
});
