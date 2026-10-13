/**
 * Parse worker entry (§4.9): runs `expandCalendar(workerData)` and posts the result. Started by
 * `run.ts` with `resourceLimits` and a wall-clock timeout; untrusted calendar data never touches
 * the main thread's heap or event loop.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { expandCalendar, type ExpandJob, type ExpandResult } from './expand.ts';

let result: ExpandResult;
try {
  result = expandCalendar(workerData as ExpandJob);
} catch {
  result = { ok: false, reason: 'error', message: 'The calendar data could not be read' };
}
parentPort?.postMessage(result);
