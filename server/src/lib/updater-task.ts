/**
 * The Portly Updater scheduled task (§18): the only way the server starts an update. The task's
 * command is fixed when Portly is installed, and the Task Scheduler service creates the process,
 * so it outlives the server it stops. schtasks.exe runs by its absolute path, with fixed arguments
 * and no shell, as the native host runs it for the Portly Server task.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

export const UPDATER_TASK = '\\Portly Updater';
const SCHTASKS_TIMEOUT_MS = 10_000;

export interface UpdaterTask {
  /** The task is registered. */
  exists(): Promise<boolean>;
  /** Asks Windows to start it; true when Windows took the request. */
  start(): Promise<boolean>;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean; shell: boolean; timeout: number; maxBuffer: number },
  callback: (error: Error | null) => void,
) => unknown;

/** %SystemRoot%\System32\schtasks.exe (only a drive-rooted SystemRoot is accepted). */
export function schtasksPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR].find(
    (value) => typeof value === 'string' && /^[a-zA-Z]:\\[^"<>|?*]*$/.test(value),
  );
  return path.win32.join(root ?? 'C:\\Windows', 'System32', 'schtasks.exe');
}

export function createUpdaterTask({ execFileImpl = execFile as ExecFile, program = schtasksPath() } = {}): UpdaterTask {
  const run = (args: readonly string[]): Promise<boolean> =>
    new Promise((resolve) => {
      try {
        execFileImpl(program, args, { windowsHide: true, shell: false, timeout: SCHTASKS_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error) => resolve(error === null));
      } catch {
        resolve(false);
      }
    });
  return {
    exists: () => run(['/query', '/tn', UPDATER_TASK]),
    start: () => run(['/run', '/tn', UPDATER_TASK]),
  };
}
