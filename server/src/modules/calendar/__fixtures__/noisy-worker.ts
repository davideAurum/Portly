/**
 * Test worker: posts what Node's `--watch` mode posts from every worker (`{'watch:import': [...]}`)
 * before the real result, like the parse worker does under `npm run dev`.
 */
import { parentPort, workerData } from 'node:worker_threads';

parentPort?.postMessage({ 'watch:import': ['file:///C:/example/worker.ts'] });
parentPort?.postMessage({ ok: 'yes' });
if ((workerData as { noResult?: boolean } | undefined)?.noResult !== true) {
  parentPort?.postMessage({ ok: true, events: [], vevents: 0, name: 'Noisy', color: null, skipped: 0 });
}
