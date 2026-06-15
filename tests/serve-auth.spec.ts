/**
 * Bearer-token auth for `mcp-gen serve` (v1.2.0).
 *
 * What this pins:
 *   - auth OFF (no keys configured): a request with no Authorization still works,
 *     i.e. behavior is unchanged from before this feature.
 *   - auth ON via `--api-key` (the `apiKeys` option): a missing, malformed, or
 *     wrong bearer is rejected with HTTP 401 + {"error":"unauthorized"} BEFORE the
 *     tool runs (proven by a process-global invocation counter), while a correct
 *     `Authorization: Bearer <key>` lets the tool call succeed.
 *   - auth ON via the MCP_GEN_API_KEYS env var (comma-separated, multiple keys):
 *     each configured key works; an unconfigured key → 401.
 *   - PORT/HOST env fallbacks are honored, and CLI --port/--host override env.
 *   - exposure-warning interplay: non-loopback + no auth → the scary warning;
 *     non-loopback + auth ON → no scary warning (auth gates the endpoint).
 *   - the pure auth primitives (env parse, key union, bearer parse, constant-time
 *     authorization) behave correctly in isolation.
 */
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startServer,
  isAuthorized,
  parseBearer,
  parseApiKeysEnv,
  resolveApiKeys,
  type ServeHandle,
} from "../src/serve";
import { parseServerArgs, serveDefaultPort, resolveBindHost } from "../src/cli";
import { ROOT } from "./helpers";

const FIXTURE = path.join(ROOT, "fixtures", "serve-auth-sample.ts");
const ENV_KEYS = "MCP_GEN_API_KEYS";

/** The exposure warning serve prints when a non-loopback host has no auth. */
const EXPOSURE_WARNING = /reachable from other machines|NO authentication/i;

/** Concatenate the text content blocks of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** How many times the fixture's `name` function has actually been invoked. */
function callCount(name: string): number {
  const g = globalThis as unknown as { __serveAuthCalls?: Record<string, number> };
  return g.__serveAuthCalls?.[name] ?? 0;
}

/**
 * Raw HTTP POST to /mcp with the given headers and a tools/call body — bypasses
 * the SDK so we can observe the auth gate directly (status + body), independent
 * of any MCP handshake. On a 401 the body never reaches the transport.
 */
async function rawMcpPost(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: { msg: "x" } },
    }),
  });
  return { status: res.status, body: await res.text() };
}

/** Connect a real SDK client (optionally with a bearer key), call `ping`, close. */
async function callPingWithKey(url: string, key: string | undefined): Promise<string> {
  const client = new Client({ name: "serve-auth-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined,
  );
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "ping", arguments: { msg: "hi" } });
    return textOf(res as any);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Pure auth primitives
// ---------------------------------------------------------------------------

describe("auth primitives", () => {
  it("parseApiKeysEnv: comma-separated, trimmed, empties dropped", () => {
    expect(parseApiKeysEnv(undefined)).toEqual([]);
    expect(parseApiKeysEnv("")).toEqual([]);
    expect(parseApiKeysEnv("   ")).toEqual([]);
    expect(parseApiKeysEnv("a")).toEqual(["a"]);
    expect(parseApiKeysEnv(" a , b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseApiKeysEnv(",,")).toEqual([]);
  });

  it("resolveApiKeys: unions CLI + env, trims, drops empties, dedupes", () => {
    expect(resolveApiKeys(undefined, undefined)).toEqual([]);
    expect(resolveApiKeys(["  "], "")).toEqual([]); // a blank --api-key never enables auth
    expect(resolveApiKeys([" k1 "], "k2, k3").sort()).toEqual(["k1", "k2", "k3"]);
    expect(resolveApiKeys(["dup"], "dup")).toEqual(["dup"]); // unioned (deduped)
  });

  it("parseBearer: extracts the token, case-insensitive scheme; rejects malformed", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("BEARER   abc")).toBe("abc");
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("abc")).toBeNull(); // no scheme
    expect(parseBearer("Bearer")).toBeNull(); // scheme only, no token
    expect(parseBearer("Basic abc")).toBeNull(); // wrong scheme
  });

  it("isAuthorized: true only for an exact configured key (constant-time)", () => {
    const keys = ["right-key", "second-key"];
    expect(isAuthorized("Bearer right-key", keys)).toBe(true);
    expect(isAuthorized("Bearer second-key", keys)).toBe(true);
    expect(isAuthorized("Bearer wrong-key", keys)).toBe(false);
    expect(isAuthorized("Bearer right-ke", keys)).toBe(false); // length-guard: shorter
    expect(isAuthorized("Bearer right-keyy", keys)).toBe(false); // longer
    expect(isAuthorized(undefined, keys)).toBe(false);
    expect(isAuthorized("Basic right-key", keys)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PORT/HOST env fallbacks (resolved in the CLI layer; CLI flags override env)
// ---------------------------------------------------------------------------

describe("PORT/HOST env fallbacks — CLI flag > env > default", () => {
  const serve = (argv: string[], dflt: number) =>
    parseServerArgs(argv, dflt, { acceptHost: true, acceptApiKey: true });

  it("serveDefaultPort: valid PORT env honored, invalid/empty falls back to default", () => {
    expect(serveDefaultPort(undefined, 3000)).toBe(3000);
    expect(serveDefaultPort("", 3000)).toBe(3000);
    expect(serveDefaultPort("5050", 3000)).toBe(5050);
    expect(serveDefaultPort("not-a-port", 3000)).toBe(3000);
    expect(serveDefaultPort("70000", 3000)).toBe(3000); // out of range
  });

  it("PORT env is honored when --port is absent, but --port overrides it", () => {
    // The env-derived default flows in as parseServerArgs' default port...
    expect(serve(["tools.ts"], serveDefaultPort("5050", 3000)).port).toBe(5050);
    // ...and an explicit --port always wins (CLI > env).
    expect(serve(["tools.ts", "--port", "6060"], serveDefaultPort("5050", 3000)).port).toBe(6060);
  });

  it("resolveBindHost: HOST env honored when --host absent, but --host overrides it", () => {
    expect(resolveBindHost(undefined, undefined)).toBeUndefined();
    expect(resolveBindHost(undefined, "0.0.0.0")).toBe("0.0.0.0"); // env honored
    expect(resolveBindHost(undefined, "  ")).toBeUndefined(); // blank env ignored
    expect(resolveBindHost("127.0.0.1", "0.0.0.0")).toBe("127.0.0.1"); // CLI overrides env
  });

  it("--api-key is rejected for dev but accepted (repeatable) for serve", () => {
    expect(parseServerArgs(["tools.ts", "--api-key", "k"], 4000).error).toMatch(/not supported for dev/i);
    const p = serve(["tools.ts", "--api-key", "k1", "--api-key=k2"], 3000);
    expect(p.error).toBeUndefined();
    expect(p.apiKeys).toEqual(["k1", "k2"]);
  });
});

// ---------------------------------------------------------------------------
// auth OFF — unchanged behavior
// ---------------------------------------------------------------------------

describe("auth OFF — no keys configured, behavior unchanged", () => {
  let handle: ServeHandle;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    savedEnv = process.env[ENV_KEYS];
    delete process.env[ENV_KEYS];
    vi.spyOn(console, "error").mockImplementation(() => {});
    handle = await startServer({ file: FIXTURE, port: 0 });
  }, 30_000);

  afterAll(async () => {
    await handle?.close().catch(() => {});
    if (savedEnv === undefined) delete process.env[ENV_KEYS];
    else process.env[ENV_KEYS] = savedEnv;
    vi.restoreAllMocks();
  });

  it("a request with no Authorization still works", async () => {
    const before = callCount("ping");
    const text = await callPingWithKey(handle.url, undefined);
    expect(text).toBe("pong: hi");
    expect(callCount("ping")).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// auth ON via --api-key (the apiKeys option)
// ---------------------------------------------------------------------------

describe("auth ON via --api-key — fail-closed enforcement", () => {
  const KEY = "s3cret-key";
  let handle: ServeHandle;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    savedEnv = process.env[ENV_KEYS];
    delete process.env[ENV_KEYS]; // isolate: keys come ONLY from the option here
    vi.spyOn(console, "error").mockImplementation(() => {});
    handle = await startServer({ file: FIXTURE, port: 0, apiKeys: [KEY] });
  }, 30_000);

  afterAll(async () => {
    await handle?.close().catch(() => {});
    if (savedEnv === undefined) delete process.env[ENV_KEYS];
    else process.env[ENV_KEYS] = savedEnv;
    vi.restoreAllMocks();
  });

  it("no Authorization header → 401 {error:unauthorized}, tool never runs", async () => {
    const before = callCount("ping");
    const res = await rawMcpPost(handle.port, {});
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    expect(callCount("ping")).toBe(before); // short-circuited before dispatch
  });

  it("malformed Authorization header → 401, tool never runs", async () => {
    const before = callCount("ping");
    const res = await rawMcpPost(handle.port, { authorization: "Basic " + KEY });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    expect(callCount("ping")).toBe(before);
  });

  it("wrong key → 401, tool never runs", async () => {
    const before = callCount("ping");
    const res = await rawMcpPost(handle.port, { authorization: "Bearer wrong-key" });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    expect(callCount("ping")).toBe(before);
  });

  it("correct Bearer <key> → the tool call succeeds and the body runs", async () => {
    const before = callCount("ping");
    const text = await callPingWithKey(handle.url, KEY);
    expect(text).toBe("pong: hi");
    expect(callCount("ping")).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// auth ON via MCP_GEN_API_KEYS env (comma-separated, multiple keys)
// ---------------------------------------------------------------------------

describe("auth ON via MCP_GEN_API_KEYS env — multiple keys", () => {
  let handle: ServeHandle;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    savedEnv = process.env[ENV_KEYS];
    // Spaces + trailing empties exercise the trim/drop-empties parsing.
    process.env[ENV_KEYS] = "key-one, key-two ,, ";
    vi.spyOn(console, "error").mockImplementation(() => {});
    handle = await startServer({ file: FIXTURE, port: 0 });
  }, 30_000);

  afterAll(async () => {
    await handle?.close().catch(() => {});
    if (savedEnv === undefined) delete process.env[ENV_KEYS];
    else process.env[ENV_KEYS] = savedEnv;
    vi.restoreAllMocks();
  });

  it("no Authorization → 401", async () => {
    const res = await rawMcpPost(handle.port, {});
    expect(res.status).toBe(401);
  });

  it("each configured key works", async () => {
    // serve uses a single stateful transport per server (one MCP session per
    // instance), so give each key its own fresh server for its initialize
    // handshake. Both read the same MCP_GEN_API_KEYS, so both keys are valid.
    for (const key of ["key-one", "key-two"]) {
      const h = await startServer({ file: FIXTURE, port: 0 });
      try {
        expect(await callPingWithKey(h.url, key), key).toBe("pong: hi");
      } finally {
        await h.close().catch(() => {});
      }
    }
  }, 30_000);

  it("an unconfigured key → 401, tool never runs", async () => {
    const before = callCount("ping");
    const res = await rawMcpPost(handle.port, { authorization: "Bearer key-three" });
    expect(res.status).toBe(401);
    expect(callCount("ping")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// exposure-warning interplay
// ---------------------------------------------------------------------------

describe("exposure warning vs auth (non-loopback host)", () => {
  let stderr: string[];
  let handle: ServeHandle | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEYS];
    delete process.env[ENV_KEYS];
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(async () => {
    await handle?.close().catch(() => {});
    handle = undefined;
    if (savedEnv === undefined) delete process.env[ENV_KEYS];
    else process.env[ENV_KEYS] = savedEnv;
    vi.restoreAllMocks();
  });

  it("non-loopback + no auth → the scary warning fires", async () => {
    handle = await startServer({ file: FIXTURE, port: 0, host: "0.0.0.0" });
    expect(stderr.join("\n")).toMatch(EXPOSURE_WARNING);
  }, 30_000);

  it("non-loopback + auth ON → no scary warning, auth confirmation instead", async () => {
    handle = await startServer({ file: FIXTURE, port: 0, host: "0.0.0.0", apiKeys: ["k"] });
    expect(stderr.join("\n")).not.toMatch(EXPOSURE_WARNING);
    // A one-line confirmation that auth is required replaces the warning.
    expect(stderr.join("\n")).toMatch(/bearer token required/i);
  }, 30_000);
});
