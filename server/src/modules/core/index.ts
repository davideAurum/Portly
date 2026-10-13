/**
 * Core module (§7 Core): health, settings, profiles & widgets, uploads, export/import, vault
 * reset, about, and the daily database backup job.
 *
 * Routes and responses:
 * - `GET /api/health` (exempt) → `{ok, version, vault, app: 'portly', apiVersion, instanceId, appUrl}`
 * - `GET /api/settings` → `Settings` · `PATCH /api/settings` (RFC 7396 merge patch) → `Settings`
 * - `GET /api/profiles` → `Profile[]` (`[]` on first run; the web seeds the first profile)
 * - `POST /api/profiles {name, copyFromId?, layout?}` → 201 `Profile`
 * - `PATCH /api/profiles/:id {name?, sort?}` → `Profile` · `DELETE /api/profiles/:id` → 204
 * - `POST /api/profiles/:id/activate` → `Settings`
 * - `PUT /api/profiles/:id/positions {items}` → `Profile`
 * - `POST /api/profiles/:id/widgets {type, config?, frame?}` → 201 `WidgetInstance`
 * - `PATCH /api/profiles/:id/widgets/:instanceId {config?, frame?}` → `WidgetInstance`
 * - `DELETE /api/profiles/:id/widgets/:instanceId` → 204
 * - `POST /api/uploads` (multipart `file`, ≤ 10 MB) → 201 `{id, url}` · `GET /api/uploads/:id` (image route)
 * - `GET /api/export` → export file (attachment)
 * - `POST /api/import/preview` (multipart `file`, ≤ 25 MB) → `{previewId, summary}`
 * - `POST /api/import/commit {previewId}` → `{ok: true, summary}`
 * - `POST /api/vault/reset` → `{vault}` (deletes every secret, new key; accounts → reauth with the
 *   status reason `credentials_reset`)
 * - `GET /api/about` → `{version, dataDir, logPath, vault}` (paths blank for the Pages site)
 *
 * Every route except health is declared `paired()`: the paired Pages site may use it (hybrid mode).
 *
 * Jobs: `core:backup` (hourly check, one backup per local day) and `core:uploads-gc` (daily:
 * uploads older than 24 h that neither the settings nor any profile layout reference are deleted).
 * The hourly `oauth_states` purge belongs to the accounts module.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  PORTLY_API_VERSION,
  ImportCommitSchema,
  PositionsUpdateSchema,
  ProfileCreateSchema,
  ProfileUpdateSchema,
  WidgetCreateSchema,
  WidgetUpdateSchema,
  type AboutResponse,
  type HealthResponse,
  type ImportPreviewResponse,
  type Profile,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { localDateStamp, runDailyBackup, runPreImportBackup } from '../../lib/backups.ts';
import { HttpError } from '../../lib/errors.ts';
import { errorFields } from '../../lib/logger.ts';
import { readMultipartFile } from '../../lib/multipart.ts';
import { exempt, multipart, paired } from '../../lib/routes.ts';
import { isPlainObject, parseSafeBody } from '../../lib/safe-json.ts';
import { parseBody } from '../../lib/validate.ts';
import { BOOKMARK_ICONS_JOB } from '../bookmarks/index.ts';
import { ICS_SYNC_JOB } from '../calendar/index.ts';
import { createProfileService } from './profiles.ts';
import { buildExport, commitImport, createPreviewStore, parseImportFile, planImport } from './transfer.ts';
import { MAX_UPLOAD_BYTES, deleteOrphanUploads, readUpload, storeUpload } from './uploads.ts';

/** How long a vault reset waits for the ICS job to record the missing feed addresses. */
const VAULT_RESET_ICS_WAIT_MS = 3_000;

export const prefixes = [
  '/api/health',
  '/api/settings',
  '/api/profiles',
  '/api/uploads',
  '/api/export',
  '/api/import',
  '/api/vault',
  '/api/about',
] as const;

/** Backups are checked hourly; a new file is written once per local day. */
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BACKUP_INITIAL_DELAY_MS = 60 * 1000;

/** Orphaned uploads are collected once a day, starting a few minutes after start-up. */
export const UPLOAD_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_GC_INITIAL_DELAY_MS = 10 * 60 * 1000;

export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

/** All profiles ordered by `sort` (invalid stored layouts read as empty). */
export function listProfiles(ctx: AppContext): Profile[] {
  return createProfileService({ db: ctx.db, log: ctx.log, settings: ctx.settings }).list();
}

const IdParam = z.string().min(1).max(512);

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'core' });
  const profiles = createProfileService({ db: ctx.db, log, settings: ctx.settings });
  const previews = createPreviewStore();

  // ---- health / about -------------------------------------------------------

  app.get('/api/health', exempt('health'), (c) => {
    const body: HealthResponse = {
      ok: true,
      version: ctx.config.version,
      vault: ctx.vault.state,
      app: 'portly',
      apiVersion: PORTLY_API_VERSION,
      instanceId: ctx.pairing.instanceId(),
      appUrl: `${ctx.config.appOrigin}/`,
      pagesUrl: ctx.config.pagesUrl,
    };
    return c.json(body);
  });

  app.get('/api/about', paired(), (c) => {
    // The paths contain the Windows user name; the Pages site's (shared) origin must not learn it.
    const fromPages = c.get('pagesCors') === true;
    const body: AboutResponse = {
      version: ctx.config.version,
      dataDir: fromPages ? '' : ctx.config.dataDir,
      logPath: fromPages ? '' : ctx.config.paths.logFile,
      vault: ctx.vault.state,
    };
    return c.json(body);
  });

  // ---- settings -------------------------------------------------------------

  app.get('/api/settings', paired(), (c) => c.json(ctx.settings.getAll()));

  app.patch('/api/settings', paired(), async (c) => {
    const patch = await parseBody(c, z.unknown());
    if (isPlainObject(patch) && Object.hasOwn(patch, 'activeProfileId')) {
      const requested = patch.activeProfileId;
      if (typeof requested === 'string' && !profiles.exists(requested)) {
        throw new HttpError(422, 'validation_failed', 'activeProfileId must reference an existing profile');
      }
      // `null` resets to the default, which is the first profile once any exists: the pointer
      // never dangles while there are profiles to point at.
      if (requested === null) patch.activeProfileId = profiles.firstId();
    }
    return c.json(ctx.settings.patch(patch));
  });

  // ---- profiles -------------------------------------------------------------

  const param = (value: string | undefined): string => {
    const parsed = IdParam.safeParse(value);
    if (!parsed.success) throw new HttpError(404, 'not_found', 'Not found');
    return parsed.data;
  };

  app.get('/api/profiles', paired(), (c) => c.json(profiles.list()));

  app.post('/api/profiles', paired(), async (c) => {
    const input = await parseSafeBody(c, ProfileCreateSchema);
    return c.json(profiles.create(input), 201);
  });

  app.patch('/api/profiles/:id', paired(), async (c) => {
    const input = await parseSafeBody(c, ProfileUpdateSchema);
    return c.json(profiles.update(param(c.req.param('id')), input));
  });

  app.delete('/api/profiles/:id', paired(), (c) => {
    profiles.remove(param(c.req.param('id')));
    return c.body(null, 204);
  });

  app.post('/api/profiles/:id/activate', paired(), (c) => c.json(profiles.activate(param(c.req.param('id')))));

  app.put('/api/profiles/:id/positions', paired(), async (c) => {
    const input = await parseSafeBody(c, PositionsUpdateSchema);
    return c.json(profiles.setPositions(param(c.req.param('id')), input));
  });

  app.post('/api/profiles/:id/widgets', paired(), async (c) => {
    const input = await parseSafeBody(c, WidgetCreateSchema);
    return c.json(profiles.addWidget(param(c.req.param('id')), input), 201);
  });

  app.patch('/api/profiles/:id/widgets/:instanceId', paired(), async (c) => {
    const input = await parseSafeBody(c, WidgetUpdateSchema);
    return c.json(profiles.updateWidget(param(c.req.param('id')), param(c.req.param('instanceId')), input));
  });

  app.delete('/api/profiles/:id/widgets/:instanceId', paired(), (c) => {
    profiles.removeWidget(param(c.req.param('id')), param(c.req.param('instanceId')));
    return c.body(null, 204);
  });

  // ---- uploads --------------------------------------------------------------

  app.post('/api/uploads', multipart('upload'), paired(), async (c) => {
    const file = await readMultipartFile(c, { maxBytes: MAX_UPLOAD_BYTES });
    return c.json(storeUpload(ctx.db, file.bytes, Date.now()), 201);
  });

  app.get('/api/uploads/:id', exempt('image'), paired(), (c) => {
    const upload = readUpload(ctx.db, c.req.param('id'));
    if (!upload) throw new HttpError(404, 'not_found', 'Upload not found');
    return c.body(new Uint8Array(upload.bytes), 200, { 'Content-Type': upload.contentType });
  });

  // ---- export / import ------------------------------------------------------

  app.get('/api/export', paired(), (c) => {
    const now = new Date();
    const file = buildExport({ db: ctx.db, log, settings: ctx.settings.getAll(), profiles: profiles.list(), now: () => now });
    c.header('Content-Disposition', `attachment; filename="portly-export-${localDateStamp(now)}.json"`);
    return c.json(file);
  });

  app.post('/api/import/preview', multipart('import'), paired(), async (c) => {
    const upload = await readMultipartFile(c, { maxBytes: MAX_IMPORT_FILE_BYTES });
    const plan = planImport(parseImportFile(upload.bytes));
    const body: ImportPreviewResponse = { previewId: previews.add(plan), summary: plan.summary };
    return c.json(body);
  });

  app.post('/api/import/commit', paired(), async (c) => {
    const { previewId } = await parseBody(c, ImportCommitSchema);
    const plan = previews.get(previewId);
    if (!plan) throw new HttpError(404, 'not_found', 'Import preview not found or expired; upload the file again');
    // Synchronous from here on: no other request can interleave between backup and commit.
    try {
      runPreImportBackup({ db: ctx.db, dir: ctx.config.paths.backupsDir, log });
    } catch (err) {
      log.error('pre-import backup failed; import aborted', errorFields(err));
      throw new HttpError(500, 'internal', 'Could not back up the database; nothing was imported');
    }
    const committed = commitImport({ db: ctx.db, settings: ctx.settings }, plan);
    previews.delete(previewId);
    log.info('config imported', { ...plan.summary.counts, missingIcons: committed.missingIcons });
    // Fetch the icons of hosts that have none yet now, not at the next hourly run.
    if (committed.missingIcons > 0) void ctx.scheduler.trigger(BOOKMARK_ICONS_JOB)?.catch(() => {});
    return c.json({ ok: true, summary: plan.summary });
  });

  // ---- vault ----------------------------------------------------------------

  app.post('/api/vault/reset', paired(), async (c) => {
    await parseBody(c, z.object({}).loose());
    await ctx.vault.reset();
    for (const account of ctx.accounts.list()) {
      try {
        ctx.accounts.setStatus(account.id, 'reauth', 'Credentials were reset', { reason: 'credentials_reset', source: 'core' });
      } catch (err) {
        log.warn('could not mark account for reconnect after vault reset', { accountId: account.id, ...errorFields(err) });
      }
    }
    // ICS feed addresses were vault secrets too: re-run the ICS job so every feed reports that its
    // address is missing now (it makes no request without one), not at the next 30-minute run.
    const ics = ctx.scheduler.trigger(ICS_SYNC_JOB);
    if (ics) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        ics.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, VAULT_RESET_ICS_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return c.json({ vault: ctx.vault.state });
  });

  // ---- jobs -----------------------------------------------------------------

  ctx.scheduler.every('core:backup', BACKUP_CHECK_INTERVAL_MS, () => runDailyBackup({ db: ctx.db, dir: ctx.config.paths.backupsDir, log }), {
    initialDelayMs: BACKUP_INITIAL_DELAY_MS,
  });

  ctx.scheduler.every(
    'core:uploads-gc',
    UPLOAD_GC_INTERVAL_MS,
    () => {
      const deleted = deleteOrphanUploads(ctx.db, Date.now());
      if (deleted > 0) log.info('orphaned uploads deleted', { count: deleted });
    },
    { initialDelayMs: UPLOAD_GC_INITIAL_DELAY_MS },
  );
}
