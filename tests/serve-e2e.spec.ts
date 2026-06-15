/**
 * E2E for `mcp-gen serve`: start the live MCP server in-process on an ephemeral
 * port, connect a real SDK Client over Streamable HTTP, and exercise the
 * runtime end-to-end.
 *
 * What this pins:
 *   - tools/list exposes only the convertible exports; the unbound-generic one
 *     is excluded (fail-loud carries over from the generator) and its exclusion
 *     is logged to stderr.
 *   - the served greet inputSchema deep-equals generateTools' raw JSON Schema —
 *     the schema flowed through to the wire untouched (no zod conversion).
 *   - named→positional dispatch: greet composes its message, and subtract keeps
 *     argument order even when the named args arrive in reverse (a values-order
 *     shortcut would compute b - a and flip the sign).
 *   - async tools are awaited before replying.
 *   - a throwing tool returns isError instead of crashing the server, which
 *     then still serves a subsequent call.
 *
 * The client connects directly to the served server — no proxy in between.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type ServeHandle } from "../src/serve";
import { generateTools } from "../src/generate";
import { ROOT } from "./helpers";

const FIXTURE = path.join(ROOT, "fixtures", "serve-sample.ts");

/** Concatenate the text content blocks of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

let handle: ServeHandle;
let client: Client;
let transport: StreamableHTTPClientTransport;
let stderr: string[];

beforeAll(async () => {
  // Capture what serve logs to stderr so we can assert the excluded tool was
  // reported. The spy also keeps test output quiet.
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  });

  handle = await startServer({ file: FIXTURE, port: 0 });

  client = new Client({ name: "serve-e2e-test", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(new URL(handle.url));
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await handle?.close();
  vi.restoreAllMocks();
});

describe("mcp-gen serve — E2E over Streamable HTTP", () => {
  it("tools/list exposes the convertible tools and excludes the unbound generic (logged to stderr)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(["boom", "greet", "slowEcho", "subtract"]);
    expect(names).not.toContain("identity");

    // The exclusion was logged to stderr — fail-loud carried over to serve.
    const log = stderr.join("\n");
    expect(log).toMatch(/identity/);
    expect(log).toMatch(/generic|could not be converted/i);

    // The greet inputSchema is the raw JSON Schema, flowed through untouched.
    const greet = tools.find((t) => t.name === "greet");
    expect(greet).toBeDefined();
    const expected = generateTools(FIXTURE).tools.find((t) => t.name === "greet")!.inputSchema;
    expect(greet!.inputSchema).toEqual(expected);
  });

  it("greet maps named args to positional and returns the greeting", async () => {
    const res = await client.callTool({ name: "greet", arguments: { name: "Ada", age: 36 } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res as any)).toBe("Hello Ada, age 36");
  });

  it("subtract preserves parameter order even when named args arrive reversed (the trap)", async () => {
    // Reversed key order on the wire — a values-order shortcut would yield -7.
    const res = await client.callTool({ name: "subtract", arguments: { b: 3, a: 10 } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res as any)).toBe("7");
  });

  it("awaits async tools before replying", async () => {
    const res = await client.callTool({ name: "slowEcho", arguments: { msg: "ping" } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res as any)).toBe("echo: ping");
  });

  it("a throwing tool returns isError and the server stays up", async () => {
    const res = await client.callTool({ name: "boom", arguments: { detail: "kaboom" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as any)).toContain("boom: kaboom");

    // The server survived the throw and still serves a subsequent call.
    const after = await client.callTool({ name: "greet", arguments: { name: "Bob", age: 7 } });
    expect(after.isError).toBeFalsy();
    expect(textOf(after as any)).toBe("Hello Bob, age 7");
  });
});
