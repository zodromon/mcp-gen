/**
 * Fixture for `mcp-gen serve` argument-validation tests.
 *
 * Each tool records its invocations on a process-global counter
 * (`globalThis.__serveValidationCalls`). The serve runtime loads this module via
 * jiti in the SAME process, so the counter is visible to the test — letting it
 * prove that a rejected call shape (a -32602 protocol error) short-circuits
 * BEFORE dispatch (counter stays 0), while a valid call DOES reach the function
 * (counter increments), and a tool that throws at runtime WAS invoked first
 * (counter increments, then isError:true comes back).
 */

/** Bump the shared invocation counter for `name`. */
function record(name: string): void {
  const g = globalThis as unknown as { __serveValidationCalls?: Record<string, number> };
  const calls = (g.__serveValidationCalls ??= {});
  calls[name] = (calls[name] ?? 0) + 1;
}

/**
 * Adds two numbers. Drives the wrong-typed-arg and missing-required-arg tests
 * (both params are required numbers).
 * @param a - first addend
 * @param b - second addend
 */
export function add(a: number, b: number): number {
  record("add");
  return a + b;
}

/**
 * Picks a color from a fixed set — exercises enum validation (a literal union
 * becomes `{ type: "string", enum: [...] }`).
 * @param color - one of the allowed colors
 */
export function pickColor(color: "red" | "green" | "blue"): string {
  record("pickColor");
  return `picked ${color}`;
}

/**
 * Always throws AFTER being invoked — proves a runtime (business) error returns
 * isError:true and is distinct from the -32602 protocol errors. The counter
 * confirms the function actually ran.
 * @param detail - folded into the thrown message
 */
export function willThrow(detail: string): string {
  record("willThrow");
  throw new Error(`runtime failure: ${detail}`);
}
