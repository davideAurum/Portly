/**
 * Other PCs (shared/src/devices.ts): the devices connected to this Portly and the requests
 * waiting for approval (`GET /api/devices`), approving or denying a request (on Portly's own page
 * on the main PC only), removing a device, and the other PC's own side of it: asking to connect,
 * polling the answer, and disconnecting itself. The list is never persisted: it must always show
 * what the server trusts now, and it is polled while Settings > Devices is open so a request from
 * another PC shows up without a reload.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  DeviceNameSuggestionResponseSchema,
  DeviceRequestCreateResponseSchema,
  DeviceRequestStatusResponseSchema,
  DeviceRequestSummarySchema,
  DeviceSelfSchema,
  DeviceStatusResponseSchema,
  DeviceSummarySchema,
  DevicesResponseSchema,
  type DeviceRequestCreateResponse,
  type DeviceRequestStatusResponse,
  type DeviceSelf,
  type DevicesResponse,
} from '@portly/shared';
import { toastError } from '../ui/toast.ts';
import { apiDelete, apiGet, apiPath, apiPost, isApiError } from './client.ts';
import { qk } from './keys.ts';

// Tolerant readers: unknown extra fields from a newer server are dropped, not fatal.
const DevicesReader = z.object({
  ...DevicesResponseSchema.shape,
  devices: z.array(z.object(DeviceSummarySchema.shape)),
  requests: z.array(z.object(DeviceRequestSummarySchema.shape)),
});
const RequestCreateReader = z.object(DeviceRequestCreateResponseSchema.shape);
const RequestStatusReader = z.object({ ...DeviceRequestStatusResponseSchema.shape, device: z.object(DeviceSelfSchema.shape).nullable() });
const StatusReader = z.object({ ...DeviceStatusResponseSchema.shape, device: z.object(DeviceSelfSchema.shape) });
const SuggestionReader = z.object(DeviceNameSuggestionResponseSchema.shape);

/** How often Settings > Devices asks again while it is open (a request from another PC appears by itself). */
export const DEVICES_POLL_MS = 5_000;

export async function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return DevicesReader.parse(await apiGet<unknown>('/api/devices', { signal }));
}

export function useDevices(options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: qk.devices(),
    queryFn: ({ signal }) => fetchDevices(signal),
    meta: { persist: false },
    refetchInterval: options.poll ? DEVICES_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
}

/** `POST /api/devices/requests/:id/approve` (Portly's own page on the main PC only). */
export function approveDeviceRequest(id: string): Promise<unknown> {
  return apiPost<unknown>(apiPath`/api/devices/requests/${id}/approve`);
}

/** `POST /api/devices/requests/:id/deny` (Portly's own page on the main PC only). */
export function denyDeviceRequest(id: string): Promise<void> {
  return apiPost<void>(apiPath`/api/devices/requests/${id}/deny`);
}

export function revokeDevice(id: string): Promise<void> {
  return apiDelete(apiPath`/api/devices/${id}`);
}

export function useApproveDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: approveDeviceRequest,
    onError: (error) => toastError(error, 'The request could not be approved.'),
    onSettled: () => client.invalidateQueries({ queryKey: qk.devices() }),
  });
}

export function useDenyDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await denyDeviceRequest(id);
      } catch (error) {
        // Already decided or expired: nothing left to deny.
        if (!isApiError(error, 'not_found')) throw error;
      }
    },
    onError: (error) => toastError(error, 'The request could not be denied.'),
    onSettled: () => client.invalidateQueries({ queryKey: qk.devices() }),
  });
}

export function useRevokeDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await revokeDevice(id);
      } catch (error) {
        // Already gone (removed in another tab, or expired): nothing left to do.
        if (!isApiError(error, 'not_found')) throw error;
      }
    },
    onError: (error) => toastError(error, 'The device could not be removed.'),
    onSettled: () => client.invalidateQueries({ queryKey: qk.devices() }),
  });
}

// ---------------------------------------------------------------------------
// The other PC's own side (the connect screen; plain calls, no query cache)
// ---------------------------------------------------------------------------

/** `POST /api/devices/requests`: asks to be connected; the server sets the enrollment cookie. */
export async function createDeviceRequest(label: string, signal?: AbortSignal): Promise<DeviceRequestCreateResponse> {
  return RequestCreateReader.parse(await apiPost<unknown>('/api/devices/requests', { label }, { signal }));
}

/**
 * `GET /api/devices/requests/suggestion`: the name to fill in for this PC (its computer name, when
 * the main PC's Tailscale can tell who is asking), or null: when the server has none, and on any
 * error, since the suggestion is a convenience and the form works without it.
 */
export async function fetchDeviceNameSuggestion(signal?: AbortSignal): Promise<string | null> {
  try {
    return SuggestionReader.parse(await apiGet<unknown>('/api/devices/requests/suggestion', { signal })).label;
  } catch {
    return null;
  }
}

/**
 * `GET /api/devices/requests/current`: the state of this PC's request, or null when there is none
 * (no enrollment cookie, or one the server no longer knows).
 */
export async function fetchDeviceRequestStatus(signal?: AbortSignal): Promise<DeviceRequestStatusResponse | null> {
  try {
    return RequestStatusReader.parse(await apiGet<unknown>('/api/devices/requests/current', { signal }));
  } catch (error) {
    if (isApiError(error, 'not_found')) return null;
    throw error;
  }
}

/**
 * `GET /api/device`: the device this page's cookie belongs to, or null when the server does not
 * take this page as a connected device (401 `login_required`: no cookie, or one that stopped
 * working; 409 `not_configured`: the request carried no device cookie at all).
 */
export async function fetchDeviceSelf(signal?: AbortSignal): Promise<DeviceSelf | null> {
  try {
    return StatusReader.parse(await apiGet<unknown>('/api/device', { signal })).device;
  } catch (error) {
    if (isApiError(error, 'login_required') || isApiError(error, 'not_configured')) return null;
    throw error;
  }
}

/** `DELETE /api/device`: this PC disconnects itself (the server clears its cookie). */
export function disconnectDevice(): Promise<void> {
  return apiDelete('/api/device');
}

export function useDisconnectDevice() {
  return useMutation({
    mutationFn: async () => {
      try {
        await disconnectDevice();
      } catch (error) {
        // Already disconnected or removed on the main PC: the reload lands on the connect screen either way.
        if (!isApiError(error, 'login_required') && !isApiError(error, 'not_configured')) throw error;
      }
    },
    onError: (error) => toastError(error, 'This PC could not be disconnected.'),
  });
}
