/**
 * Test-only stand-in for schtasks.exe, for the end-to-end runs of the native host
 * (scripts/tests/native-host-launcher.test.mjs, scripts/check-scripts.ps1). It makes sure a test
 * can never run the real `schtasks /run /tn "\Homebase Server"`, which would start the user's real
 * Homebase once the task is installed.
 *
 * Preload it into the launcher's node process through the environment, which reaches node
 * through launcher.cmd exactly as the browser's environment does:
 *
 *   NODE_OPTIONS=--import=<file URL of this file>
 *   HOMEBASE_TEST_SCHTASKS=success | missing | denied    (default: success)
 *   HOMEBASE_TEST_SCHTASKS_LOG=<file>                    (optional: one JSON line per call)
 *
 * As a preload it replaces child_process.execFile (the only way launcher.mjs runs a program) for
 * the whole process, records each call and runs this file instead, as a child script with the
 * caller's options (no shell, hidden window) and the original arguments. If the replacement
 * cannot be verified, the import throws and node exits before the launcher runs: fail closed.
 *
 * As that child script (HOMEBASE_TEST_SCHTASKS_CHILD=1) it prints what schtasks.exe prints on
 * English Windows and exits with its exit code.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const mode = process.env.HOMEBASE_TEST_SCHTASKS || 'success';

const OUTCOMES = {
  success: { code: 0, stdout: 'SUCCESS: Attempted to run the scheduled task "\\Homebase Server".\r\n', stderr: '' },
  missing: { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.\r\n' },
  denied: { code: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' },
};

if (process.env.HOMEBASE_TEST_SCHTASKS_CHILD === '1') {
  const outcome = OUTCOMES[mode];
  if (!outcome) {
    process.stderr.write(`schtasks-stub: unknown HOMEBASE_TEST_SCHTASKS "${mode}"\r\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(outcome.stdout);
    process.stderr.write(outcome.stderr);
    process.exitCode = outcome.code;
  }
} else {
  const realExecFile = childProcess.execFile;

  const fakeExecFile = function execFile(file, args, options, callback) {
    if (typeof args === 'function') {
      callback = args;
      args = [];
      options = {};
    } else if (typeof options === 'function') {
      callback = options;
      options = Array.isArray(args) ? {} : args;
      if (!Array.isArray(args)) args = [];
    }
    const argv = Array.isArray(args) ? args.map(String) : [];
    const log = process.env.HOMEBASE_TEST_SCHTASKS_LOG;
    if (log) fs.appendFileSync(log, `${JSON.stringify({ file: String(file), args: argv })}\n`, 'utf8');
    const env = { ...(options?.env ?? process.env), HOMEBASE_TEST_SCHTASKS_CHILD: '1' };
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'NODE_OPTIONS') delete env[name];
    return realExecFile(process.execPath, [selfPath, ...argv], { ...(options ?? {}), env }, callback);
  };

  childProcess.execFile = fakeExecFile;
  syncBuiltinESMExports();
  const live = await import('node:child_process');
  if (live.execFile !== fakeExecFile || live.default.execFile !== fakeExecFile) {
    throw new Error('schtasks-stub: could not replace child_process.execFile; refusing to run (a real schtasks.exe could run)');
  }
}
