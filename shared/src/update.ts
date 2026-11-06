/**
 * The Update button (Settings → About; ARCHITECTURE §18, design/update-button.md): what the server
 * knows about the installed version and the newest release, and how an update run went. Versions
 * are ordered by `version.ts`.
 */
import { z } from 'zod';
import { IsoDateTime } from './core.ts';
import { MAX_VERSION_LENGTH } from './version.ts';

/** The version syntax `scripts/install.ps1` accepts (`Test-InstVersion`). */
export const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
/** `owner/name`, as `scripts/install.ps1` checks `-ReleaseRepo`. */
export const RELEASE_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const VersionSchema = z.string().max(MAX_VERSION_LENGTH).regex(RELEASE_VERSION_PATTERN);

export const UPDATE_RUN_STATES = ['requested', 'downloading', 'installing', 'restarting', 'done', 'failed', 'rolled-back'] as const;
export const UpdateRunStateSchema = z.enum(UPDATE_RUN_STATES);
export type UpdateRunState = z.output<typeof UpdateRunStateSchema>;

/** Closed on purpose: the installer's own messages hold paths, and this reaches other PCs. */
export const UPDATE_RUN_CODES = ['download_failed', 'checksum_mismatch', 'file_in_use', 'not_newer', 'did_not_start', 'unknown'] as const;
export const UpdateRunCodeSchema = z.enum(UPDATE_RUN_CODES);
export type UpdateRunCode = z.output<typeof UpdateRunCodeSchema>;

/** `<data folder>\update-status.json`, written by the server (`requested`) and then `install.ps1`. */
export const UpdateRunSchema = z
  .object({
    id: z.string().min(1).max(64),
    state: UpdateRunStateSchema,
    from: VersionSchema,
    to: VersionSchema.nullable(),
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime.nullable(),
    code: UpdateRunCodeSchema.nullable(),
    extensionChanged: z.boolean(),
  })
  .strict();
export type UpdateRun = z.output<typeof UpdateRunSchema>;

/** True while a run is still going: a finished one is `done`, `failed` or `rolled-back`. */
export function isUpdateRunActive(run: Pick<UpdateRun, 'state'>): boolean {
  return run.state !== 'done' && run.state !== 'failed' && run.state !== 'rolled-back';
}

/**
 * Whether the button can work here: `checkout` a Git checkout, `unsupervised` not started by the
 * supervisor, `no-task` the Portly Updater task is missing.
 */
export const UPDATE_AVAILABILITIES = ['ready', 'checkout', 'unsupervised', 'no-task'] as const;
export const UpdateAvailabilitySchema = z.enum(UPDATE_AVAILABILITIES);
export type UpdateAvailability = z.output<typeof UpdateAvailabilitySchema>;

/** `GET /api/update` */
export const UpdateStatusResponseSchema = z
  .object({
    availability: UpdateAvailabilitySchema,
    installed: z.string(),
    /** Null until a check has worked. */
    latest: VersionSchema.nullable(),
    updateAvailable: z.boolean(),
    /** The latest release's page; the server builds it, it never comes from GitHub's answer. */
    notesUrl: z.string().max(512).nullable(),
    checkedAt: IsoDateTime.nullable(),
    checkFailed: z.boolean(),
    run: UpdateRunSchema.nullable(),
  })
  .strict();
export type UpdateStatusResponse = z.output<typeof UpdateStatusResponseSchema>;

/** `POST /api/update`: the version the user was shown. */
export const UpdateStartSchema = z.object({ version: VersionSchema }).strict();
export type UpdateStart = z.output<typeof UpdateStartSchema>;

/** `POST /api/update` → 202 */
export const UpdateStartResponseSchema = z.object({ run: UpdateRunSchema }).strict();
export type UpdateStartResponse = z.output<typeof UpdateStartResponseSchema>;
