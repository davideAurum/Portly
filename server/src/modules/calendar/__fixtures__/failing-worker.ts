/**
 * Test worker that ends without posting a result: `{mode: 'exit'}` exits with code 3, anything
 * else throws an error whose message quotes calendar data (which the parent must never log).
 */
import { workerData } from 'node:worker_threads';

if ((workerData as { mode?: string } | undefined)?.mode === 'exit') process.exit(3);
throw new TypeError('Unexpected SUMMARY:Dentist appointment in line 7');
