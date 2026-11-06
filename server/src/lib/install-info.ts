/**
 * What kind of install this server runs from (§18): a release install has `release.json` beside
 * the server, in a folder named `app`, and updates from the repository it names; anything else is
 * a Git checkout. Read once at start-up; a file that does not look right counts as a checkout, so
 * the Update button is simply not offered.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_REPO_PATTERN } from '@portly/shared';

export const INSTALL_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface InstallInfo {
  /** The repository a release install updates from; null in a Git checkout. */
  releaseRepo: string | null;
}

export function readInstallInfo(root: string = INSTALL_ROOT): InstallInfo {
  if (path.basename(root).toLowerCase() !== 'app') return { releaseRepo: null };
  try {
    const release = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8')) as { name?: unknown; releaseRepo?: unknown };
    if (release.name === 'portly' && typeof release.releaseRepo === 'string' && RELEASE_REPO_PATTERN.test(release.releaseRepo)) {
      return { releaseRepo: release.releaseRepo };
    }
  } catch {
    // Missing or unreadable: not a release install.
  }
  return { releaseRepo: null };
}
