/**
 * E2E fixture for `mcp-gen serve`. Each export probes one behavior the runtime
 * must get right:
 *   - greet      → named→positional dispatch with two primitives
 *   - subtract   → the order-sensitivity trap (a named→positional swap flips the sign)
 *   - slowEcho   → async tool; the server must await the result before replying
 *   - boom       → throwing tool; the server must return isError and stay up
 *   - identity   → unbound generic in input position; generateTools excludes it,
 *                  so it must NOT be served (fail-loud carries over to serve).
 */

/**
 * Greets a person by name and age.
 * @param name - The person's name
 * @param age - The person's age in years
 */
export function greet(name: string, age: number): string {
  return `Hello ${name}, age ${age}`;
}

/**
 * Subtracts b from a. Order-sensitivity probe: reconstructing arguments out of
 * order would compute `b - a` and flip the sign.
 * @param a - The minuend
 * @param b - The subtrahend
 */
export function subtract(a: number, b: number): number {
  return a - b;
}

/**
 * Echoes a message after a tick — proves the handler awaits async results.
 * @param msg - The message to echo back
 */
export async function slowEcho(msg: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return `echo: ${msg}`;
}

/**
 * Always throws — proves a thrown tool becomes `isError: true` rather than
 * crashing the server.
 * @param detail - Text folded into the thrown message
 */
export function boom(detail: string): string {
  throw new Error(`boom: ${detail}`);
}

/**
 * Unbound generic in input position. generateTools cannot convert `value: T`
 * to a JSON Schema (no concrete type), so it is a hard error and excluded —
 * it must never appear in the served tool list.
 */
export function identity<T>(value: T): T {
  return value;
}
