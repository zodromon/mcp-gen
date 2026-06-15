/**
 * Fixture for `mcp-gen serve` bearer-auth tests.
 *
 * `ping` records each invocation on a process-global counter
 * (`globalThis.__serveAuthCalls`). The serve runtime loads this module via jiti
 * in the SAME process, so the counter is visible to the test — letting it prove
 * that a 401 (missing / wrong / malformed bearer) short-circuits BEFORE the tool
 * runs (the counter must not move on a rejected request), while an authorized
 * call DOES reach the function (counter increments).
 */

/** Bump the shared invocation counter for `name`. */
function record(name: string): void {
  const g = globalThis as unknown as { __serveAuthCalls?: Record<string, number> };
  const calls = (g.__serveAuthCalls ??= {});
  calls[name] = (calls[name] ?? 0) + 1;
}

/**
 * Echoes a message back, recording that the tool body actually executed.
 * @param msg - The message to echo back
 */
export function ping(msg: string): string {
  record("ping");
  return `pong: ${msg}`;
}
