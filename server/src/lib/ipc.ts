/**
 * Supervisor → server IPC (§3, §12): the supervisor asks the server to shut down gracefully with
 * {@link SHUTDOWN_MESSAGE} over the child-process channel (Windows cannot deliver signals to a
 * child process: `ChildProcess.kill(signal)` terminates it immediately).
 */
export const SHUTDOWN_MESSAGE = Object.freeze({ type: 'shutdown' });

export function isShutdownMessage(message: unknown): boolean {
  return message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'shutdown';
}
