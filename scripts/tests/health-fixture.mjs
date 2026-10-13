/**
 * Loopback HTTP fixture for scripts/check-scripts.ps1: four listeners on 127.0.0.1 (random free
 * ports) that answer GET /api/health as Homebase, with non-JSON, with HTTP 503, or never.
 * Prints the ports as one JSON line and exits when stdin closes, which check-scripts.ps1 does at
 * its end. The 15-minute cap only stops a fixture whose parent died; it must outlast both child-run
 * passes (Windows PowerShell 5.1 and PowerShell 7), or their port checks find nothing listening.
 */
import http from 'node:http';

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const servers = {
  ok: await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '9.9.9-fixture', vault: 'locked' }));
  }),
  notJson: await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Some other app</title>');
  }),
  error: await listen((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  }),
  hang: await listen(() => {
    // Never answer.
  }),
};

const ports = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, server.address().port]));
process.stdout.write(`${JSON.stringify(ports)}\n`);

function shutdown() {
  for (const server of Object.values(servers)) server.closeAllConnections?.();
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.resume();
setTimeout(shutdown, 15 * 60_000).unref?.();
