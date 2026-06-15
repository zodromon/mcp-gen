/**
 * E2E for `mcp-gen serve` argument validation: a real SDK Client over Streamable
 * HTTP exercises the CallTool handler's hardening.
 *
 * The contract under test (closes the "agent invented the tool or its schema"
 * gap — a malformed call must surface as a protocol error):
 *   - Unknown tool name → a JSON-RPC PROTOCOL error (code in the -32601/-32602
 *     range), not a result with isError. The SDK client REJECTS.
 *   - Wrong-typed / missing-required / failed-enum argument → -32602
 *     (InvalidParams), and the underlying function is NEVER invoked — proven by
 *     a process-global invocation counter the fixture maintains.
 *   - A valid call still succeeds unchanged (regression).
 *   - A tool that runs and THROWS still returns isError:true (a business error,
 *     distinct from the -32602 protocol errors above) — and the counter confirms
 *     it actually ran.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { startServer, type ServeHandle } from "../src/serve";
import { ROOT } from "./helpers";

const FIXTURE = path.join(ROOT, "fixtures", "serve-validation-sample.ts");

/** Concatenate the text content blocks of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** How many times the fixture's `name` function has actually been invoked. */
function callCount(name: string): number {
  const g = globalThis as unknown as { __serveValidationCalls?: Record<string, number> };
  return g.__serveValidationCalls?.[name] ?? 0;
}

let handle: ServeHandle;
let client: Client;
let transport: StreamableHTTPClientTransport;

/** Call a tool, returning either the resolved result or the rejection error. */
async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ rejected: false; result: any } | { rejected: true; error: any }> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { rejected: false, result };
  } catch (error) {
    return { rejected: true, error };
  }
}

beforeAll(async () => {
  // Keep serve's startup logging out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});

  handle = await startServer({ file: FIXTURE, port: 0 });

  client = new Client({ name: "serve-validation-test", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(new URL(handle.url));
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await handle?.close();
  vi.restoreAllMocks();
});

describe("mcp-gen serve — argument validation (protocol errors vs isError)", () => {
  it("unknown tool name → JSON-RPC protocol error, not a result with isError", async () => {
    const outcome = await call("deleteDatabase", {});

    // The SDK call REJECTS (a JSON-RPC error response), rather than resolving to
    // { isError: true }. The error code is in the JSON-RPC protocol-error range.
    expect(outcome.rejected).toBe(true);
    if (outcome.rejected) {
      expect([ErrorCode.MethodNotFound, ErrorCode.InvalidParams]).toContain(outcome.error.code);
      expect(outcome.error.code).toBe(ErrorCode.MethodNotFound); // -32601, our chosen code
    }
  });

  it("wrong-typed arg (string where schema says number) → -32602 and the function is NOT invoked", async () => {
    const before = callCount("add");
    const outcome = await call("add", { a: "ten", b: 2 });

    expect(outcome.rejected).toBe(true);
    if (outcome.rejected) {
      expect(outcome.error.code).toBe(ErrorCode.InvalidParams); // -32602
      expect(String(outcome.error.message)).toMatch(/a.*number|number.*a/i);
    }
    // Validation short-circuited before dispatch: add() never ran.
    expect(callCount("add")).toBe(before);
  });

  it("missing required arg → -32602 and the function is NOT invoked", async () => {
    const before = callCount("add");
    const outcome = await call("add", { a: 1 }); // b is required, omitted

    expect(outcome.rejected).toBe(true);
    if (outcome.rejected) {
      expect(outcome.error.code).toBe(ErrorCode.InvalidParams); // -32602
      expect(String(outcome.error.message)).toMatch(/required.*b|b.*required/i);
    }
    expect(callCount("add")).toBe(before);
  });

  it("failed enum → -32602 and the function is NOT invoked", async () => {
    const before = callCount("pickColor");
    const outcome = await call("pickColor", { color: "purple" });

    expect(outcome.rejected).toBe(true);
    if (outcome.rejected) {
      expect(outcome.error.code).toBe(ErrorCode.InvalidParams); // -32602
    }
    expect(callCount("pickColor")).toBe(before);
  });

  it("a valid call still succeeds unchanged (regression)", async () => {
    const before = callCount("add");
    const outcome = await call("add", { a: 2, b: 3 });

    expect(outcome.rejected).toBe(false);
    if (!outcome.rejected) {
      expect(outcome.result.isError).toBeFalsy();
      expect(textOf(outcome.result)).toBe("5");
    }
    // The valid call DID reach the function.
    expect(callCount("add")).toBe(before + 1);
  });

  it("a tool that runs and throws still returns isError:true (distinct from -32602)", async () => {
    const before = callCount("willThrow");
    const outcome = await call("willThrow", { detail: "kaboom" });

    // A business error: the call RESOLVES with isError, it does not reject as a
    // protocol error. The two are not collapsed.
    expect(outcome.rejected).toBe(false);
    if (!outcome.rejected) {
      expect(outcome.result.isError).toBe(true);
      expect(textOf(outcome.result)).toContain("runtime failure: kaboom");
    }
    // The function WAS invoked (its shape was valid) — it just threw.
    expect(callCount("willThrow")).toBe(before + 1);
  });
});
