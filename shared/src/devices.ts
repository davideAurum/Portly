/**
 * Devices: other PCs using the Portly server on the main PC through an HTTPS reverse proxy
 * (ARCHITECTURE §4.2 remote branch; the design in docs/design/multi-pc.md).
 *
 * The server stays on loopback. Requests whose Host header is the one of `PORTLY_REMOTE_ORIGIN`
 * come from another PC and need a device cookie ({@link DEVICE_COOKIE}), granted like this:
 * the other PC asks (`POST /api/devices/requests`) and gets a short display code and an enrollment
 * cookie ({@link ENROLL_COOKIE}); the main PC approves the request from Settings > Devices (a
 * local-only route); the other PC, polling `GET /api/devices/requests/current`, then receives the
 * device cookie. The server stores only SHA-256 hashes of both cookies. The code is for comparing
 * by eye on both screens; it is not a secret and opens nothing by itself.
 */
import { z } from 'zod';
import { IsoDateTime } from './core.ts';

/** The login cookie of an approved device (`__Host-`: Secure, Path=/, no Domain). */
export const DEVICE_COOKIE = '__Host-portly_device';
/**
 * The cookie of a pending request, until it is approved and swapped for {@link DEVICE_COOKIE}. It
 * outlives the request a little, so the other PC's last poll can still learn that it expired.
 */
export const ENROLL_COOKIE = '__Host-portly_enroll';

/** A request not approved within this long expires (and so does its enrollment cookie). */
export const DEVICE_REQUEST_TTL_MS = 10 * 60 * 1000;
/** At most this many requests wait for approval at once (one more is refused with 429). */
export const MAX_PENDING_DEVICE_REQUESTS = 3;
/** A device not used for this long must be connected again. */
export const DEVICE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many devices are connected at once; one more replaces the least recently used. */
export const MAX_DEVICES = 20;

/** Display codes use letters and digits that are hard to confuse (no 0/O, 1/I/L). */
export const DEVICE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DEVICE_CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;
export const DeviceCodeSchema = z.string().regex(DEVICE_CODE_REGEX);

/** 32 random bytes as base64url (no padding): the value of either cookie. */
export const DeviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const DEVICE_LABEL_MAX = 60;
/**
 * The name the other PC gives itself ("Laptop"), shown on the main PC when approving: one line,
 * no control, line-separator or bidi-override characters (it comes from an unauthenticated request).
 */
export const DeviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(DEVICE_LABEL_MAX)
  .regex(/^[^\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u, 'One line without control or bidi characters');

/** `POST /api/devices/requests {label}`. */
export const DeviceRequestCreateSchema = z.object({ label: DeviceLabelSchema }).strict();
export type DeviceRequestCreate = z.output<typeof DeviceRequestCreateSchema>;

export const DeviceRequestCreateResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    code: DeviceCodeSchema,
    expiresAt: IsoDateTime,
  })
  .strict();
export type DeviceRequestCreateResponse = z.output<typeof DeviceRequestCreateResponseSchema>;

export const DEVICE_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export const DeviceRequestStatusSchema = z.enum(DEVICE_REQUEST_STATUSES);
export type DeviceRequestStatus = z.output<typeof DeviceRequestStatusSchema>;

/** The presenting device's own record (`GET /api/device`, and the answer that connects it). */
export const DeviceSelfSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().max(DEVICE_LABEL_MAX),
    createdAt: IsoDateTime,
  })
  .strict();
export type DeviceSelf = z.output<typeof DeviceSelfSchema>;

/**
 * `GET /api/devices/requests/current` (the enrollment cookie decides which request): `pending`
 * with the code to compare; `approved` once, with the device cookie set and the enrollment cookie
 * cleared; `denied` or `expired` with the enrollment cookie cleared.
 */
export const DeviceRequestStatusResponseSchema = z
  .object({
    status: DeviceRequestStatusSchema,
    id: z.string().min(1).max(64),
    code: DeviceCodeSchema,
    expiresAt: IsoDateTime,
    device: DeviceSelfSchema.nullable(),
  })
  .strict();
export type DeviceRequestStatusResponse = z.output<typeof DeviceRequestStatusResponseSchema>;

/** `GET /api/device`: the device the request's cookie belongs to. */
export const DeviceStatusResponseSchema = z.object({ device: DeviceSelfSchema }).strict();
export type DeviceStatusResponse = z.output<typeof DeviceStatusResponseSchema>;

export const DeviceSummarySchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().max(DEVICE_LABEL_MAX),
    /** "Chrome on Windows", from the User-Agent of the request that asked. */
    browser: z.string().max(200),
    createdAt: IsoDateTime,
    lastUsedAt: IsoDateTime.nullable(),
    /** The device whose cookie this request carries. */
    current: z.boolean(),
  })
  .strict();
export type DeviceSummary = z.output<typeof DeviceSummarySchema>;

export const DeviceRequestSummarySchema = z
  .object({
    id: z.string().min(1).max(64),
    code: DeviceCodeSchema,
    label: z.string().max(DEVICE_LABEL_MAX),
    browser: z.string().max(200),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
  })
  .strict();
export type DeviceRequestSummary = z.output<typeof DeviceRequestSummarySchema>;

/** `GET /api/devices`: the connected devices and the requests waiting for approval. */
export const DevicesResponseSchema = z
  .object({
    /** `PORTLY_REMOTE_ORIGIN`, or null when other PCs cannot connect. */
    remoteOrigin: z.string().nullable(),
    devices: z.array(DeviceSummarySchema),
    requests: z.array(DeviceRequestSummarySchema),
  })
  .strict();
export type DevicesResponse = z.output<typeof DevicesResponseSchema>;

/** `POST /api/devices/requests/:id/approve` → the device record is made when the other PC next polls. */
export const DeviceApproveResponseSchema = z.object({ approved: z.literal(true) }).strict();
export type DeviceApproveResponse = z.output<typeof DeviceApproveResponseSchema>;
