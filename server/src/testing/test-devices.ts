/**
 * Device helpers for tests (other PCs, shared/src/devices.ts): a connected device made straight
 * through the store (request → approve → claim), and the cookie of a `Set-Cookie` list.
 */
import type { AppContext } from '../context.ts';
import type { DeviceRecord } from '../security/devices.ts';

export interface TestDevice {
  /** The device cookie's value (what `remoteHeaders(secret)` sends). */
  secret: string;
  record: DeviceRecord;
}

/** A connected device: its request is approved and claimed at once. Throws when the request limit is hit. */
export function connectTestDevice(ctx: Pick<AppContext, 'devices'>, input: { label?: string; browser?: string } = {}): TestDevice {
  const created = ctx.devices.createRequest({ label: input.label ?? 'Laptop', browser: input.browser ?? 'Chrome on Windows' });
  if (created === null) throw new Error('too many device requests are pending');
  if (ctx.devices.approve(created.record.id) === null) throw new Error('could not approve the device request');
  const claimed = ctx.devices.claim(created.secret);
  if (claimed === null) throw new Error('could not claim the device request');
  return { secret: claimed.secret, record: claimed.record };
}

/** The one `Set-Cookie` header of `res` for `name` (`name=value; …`), or undefined; throws when there are several. */
export function setCookieFor(res: Response, name: string): string | undefined {
  const lines = res.headers.getSetCookie().filter((line) => line.startsWith(`${name}=`));
  if (lines.length > 1) throw new Error(`${lines.length} Set-Cookie headers for ${name}: ${lines.join(' | ')}`);
  return lines[0];
}

/** The value part of a `Set-Cookie` line (`name=value; …` → `value`). */
export function cookieValueOf(line: string): string {
  const [pair = ''] = line.split(';', 1);
  return pair.slice(pair.indexOf('=') + 1);
}
