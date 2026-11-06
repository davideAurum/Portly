/**
 * Update module (§18, design/update-button.md): the Update button's server side. Nothing here
 * installs anything. `POST /api/update` starts the Portly Updater task, whose command takes no
 * input from a request, and `install.ps1` reports how it goes in `<data folder>\update-status.json`.
 *
 * Routes and responses:
 * - `GET /api/update` [paired] → `UpdateStatusResponse`. Only a `ready` install asks GitHub, at most
 *   hourly (`?refresh=1`: at most once a minute), and only when someone opens the card.
 * - `POST /api/update {version}` [own-page] → 202 `{run}`. 409 `conflict` when the button cannot
 *   work here, when `version` is no longer the newest release or is not newer than this one, or
 *   when Windows refused to start the task; 502 `provider_error` when GitHub cannot be reached. A
 *   run already going answers 202 with that run. Asks GitHub at most once a minute too.
 *
 * Starting an update is `ownPage()`, never the Pages site: the Pages site and the releases are
 * published from one GitHub account, so whoever could publish a bad release could otherwise also
 * have the site start it, with nobody choosing to (design/update-button.md section 7). Portly's own
 * page is code this server served, so a person still has to click.
 *
 * GitHub's answer is hostile: only `tag_name` is read, and it must be a valid version. Logs carry
 * versions and outcomes, never paths (§17).
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  UpdateRunSchema,
  UpdateStartSchema,
  VersionSchema,
  isNewerVersion,
  isUpdateRunActive,
  type UpdateAvailability,
  type UpdateRun,
  type UpdateStartResponse,
  type UpdateStatusResponse,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { errorFields } from '../../lib/logger.ts';
import { ownPage, paired } from '../../lib/routes.ts';
import { parseBody } from '../../lib/validate.ts';
import { SIZE_CAPS } from '../../security/safe-fetch.ts';

export const prefixes = ['/api/update'] as const;

export const CHECK_TTL_MS = 60 * 60 * 1000;
export const REFRESH_LIMIT_MS = 60 * 1000;
/** How often Windows is asked whether the task exists, until it does. */
export const TASK_RECHECK_MS = 60 * 1000;
/** A `requested` run with no progress after this: the task never started. */
export const REQUESTED_STALE_MS = 2 * 60 * 1000;
/** Any other unfinished run after this: the installer died. Longer than the task's 15-minute limit. */
export const RUN_STALE_MS = 20 * 60 * 1000;
/** How long a finished run is still reported. */
export const FINISHED_RUN_SHOWN_MS = 24 * 60 * 60 * 1000;

const LatestReleaseSchema = z.object({ tag_name: z.string().max(80) });

interface LatestCheck {
  version: string | null;
  checkedAt: number;
  /** When the last attempt, good or bad, was made. */
  attemptedAt: number;
  failed: boolean;
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'update' });
  const statusFile = ctx.config.paths.updateStatus;
  const { releaseRepo } = ctx.install;
  const installed = ctx.config.version;

  let taskFound = false;
  let taskCheckedAt = Number.NEGATIVE_INFINITY;
  let taskCheck: Promise<boolean> | null = null;
  let check: LatestCheck | null = null;
  let checking: Promise<LatestCheck> | null = null;
  let starting: Promise<UpdateRun> | null = null;

  /** Each look starts a process, so concurrent callers share one, at most one a minute. */
  const findTask = (): Promise<boolean> => {
    if (taskFound || Date.now() - taskCheckedAt < TASK_RECHECK_MS) return Promise.resolve(taskFound);
    taskCheck ??= ctx.updaterTask.exists().then((found) => {
      taskFound = found;
      taskCheckedAt = Date.now();
      taskCheck = null;
      return found;
    });
    return taskCheck;
  };

  const availability = async (): Promise<UpdateAvailability> => {
    if (releaseRepo === null) return 'checkout';
    if (!ctx.runtime.supervised) return 'unsupervised';
    return (await findTask()) ? 'ready' : 'no-task';
  };

  const fetchLatest = async (): Promise<string> => {
    const res = await ctx.fetch(`https://api.github.com/repos/${releaseRepo ?? ''}/releases/latest`, {
      policy: 'provider',
      as: 'json',
      maxBytes: SIZE_CAPS.json,
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
    const { tag_name: tag } = LatestReleaseSchema.parse(res.data);
    return VersionSchema.parse(tag.replace(/^v/, ''));
  };

  /** Asks GitHub; concurrent callers share one request. A failure keeps the last good version. */
  const runCheck = (): Promise<LatestCheck> => {
    checking ??= fetchLatest()
      .then((version): LatestCheck => ({ version, checkedAt: Date.now(), attemptedAt: Date.now(), failed: false }))
      .catch((err: unknown): LatestCheck => {
        log.warn('update check failed', errorFields(err));
        return { version: check?.version ?? null, checkedAt: check?.checkedAt ?? 0, attemptedAt: Date.now(), failed: true };
      })
      .then((result) => {
        check = result;
        checking = null;
        return result;
      });
    return checking;
  };

  const cachedCheck = (refresh: boolean): Promise<LatestCheck> => {
    if (check !== null) {
      const sinceAttempt = Date.now() - check.attemptedAt;
      if (sinceAttempt < REFRESH_LIMIT_MS || (!refresh && !check.failed && sinceAttempt < CHECK_TTL_MS)) return Promise.resolve(check);
    }
    return runCheck();
  };

  const writeRun = async (run: UpdateRun): Promise<void> => {
    const temp = `${statusFile}.${randomUUID()}.new`;
    await writeFile(temp, JSON.stringify(run), 'utf8');
    await rename(temp, statusFile);
  };

  /** The run to report. The file is the installer's: anything that does not parse is no run. */
  const readRun = async (): Promise<UpdateRun | null> => {
    let json: unknown;
    try {
      json = JSON.parse((await readFile(statusFile, 'utf8')).replace(/^﻿/, ''));
    } catch {
      return null;
    }
    const parsed = UpdateRunSchema.safeParse(json);
    if (!parsed.success) return null;
    const run = parsed.data;
    const stillShown = (finishedAt: string): boolean => Date.now() - Date.parse(finishedAt) <= FINISHED_RUN_SHOWN_MS;
    if (!isUpdateRunActive(run)) return stillShown(run.finishedAt ?? run.startedAt) ? run : null;

    const deadline = Date.parse(run.startedAt) + (run.state === 'requested' ? REQUESTED_STALE_MS : RUN_STALE_MS);
    if (Date.now() <= deadline) return run;
    // The installer stopped writing. Whether it got there shows in the version answering now.
    const finishedAt = new Date(deadline).toISOString();
    if (!stillShown(finishedAt)) return null;
    const arrived = run.to !== null && !isNewerVersion(run.to, installed);
    return arrived ? { ...run, state: 'done', code: null, finishedAt } : { ...run, state: 'failed', code: 'unknown', finishedAt };
  };

  const startRun = async (version: string): Promise<UpdateRun> => {
    if ((await availability()) !== 'ready') throw new HttpError(409, 'conflict', 'This Portly cannot update itself from here.');
    const current = await readRun();
    if (current !== null && isUpdateRunActive(current)) return current;
    const { version: latest, failed } = await cachedCheck(true);
    if (failed) throw new HttpError(502, 'provider_error', 'Could not reach GitHub to check the newest release.');
    if (latest !== version || !isNewerVersion(version, installed)) {
      throw new HttpError(409, 'conflict', 'That is no longer the newest release. Check again.');
    }
    const run: UpdateRun = {
      id: randomUUID(),
      state: 'requested',
      from: installed,
      to: version,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      code: null,
      extensionChanged: false,
    };
    await writeRun(run);
    if (!(await ctx.updaterTask.start())) {
      await writeRun({ ...run, state: 'failed', code: 'unknown', finishedAt: new Date().toISOString() });
      log.warn('update not started: Windows refused the task', { from: installed, to: version });
      throw new HttpError(409, 'conflict', 'Windows would not start the Portly Updater task.');
    }
    log.info('update started', { from: installed, to: version });
    return run;
  };

  app.get('/api/update', paired(), async (c) => {
    const state = await availability();
    const latest = state === 'ready' ? await cachedCheck(c.req.query('refresh') === '1') : null;
    const version = latest?.version ?? null;
    const body: UpdateStatusResponse = {
      availability: state,
      installed,
      latest: version,
      updateAvailable: version !== null && isNewerVersion(version, installed),
      notesUrl: version === null ? null : `https://github.com/${releaseRepo ?? ''}/releases/tag/v${version}`,
      checkedAt: latest !== null && latest.checkedAt > 0 ? new Date(latest.checkedAt).toISOString() : null,
      checkFailed: latest?.failed === true,
      run: await readRun(),
    };
    return c.json(body);
  });

  app.post('/api/update', ownPage(), async (c) => {
    const { version } = await parseBody(c, UpdateStartSchema);
    // Two clicks at once, from two PCs say, start one run.
    starting ??= startRun(version).finally(() => {
      starting = null;
    });
    const body: UpdateStartResponse = { run: await starting };
    return c.json(body, 202);
  });
}
