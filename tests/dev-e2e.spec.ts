/**
 * Stage A E2E for `mcp-gen dev`: start the playground HTTP server in-process on
 * an ephemeral 127.0.0.1 port and exercise the API the UI will sit on top of.
 *
 * What this pins:
 *   - GET /api/tools lists the convertible exports (greet/subtract/slowEcho/boom)
 *     and EXCLUDES the unbound-generic identity, which appears in `errors`
 *     (fail-loud carries over from the generator through the shared seam).
 *   - POST /api/call runs a tool via the SAME callable seam serve uses.
 *   - A throwing tool returns { isError } and the server STAYS UP.
 *   - The server binds 127.0.0.1 only.
 *   - After the file is rewritten on disk, an SSE `reload` fires AND a subsequent
 *     /api/call runs the NEW code — the cache-invalidation proof.
 *
 * Uses a throwaway temp fixture (not the shared serve fixtures) so it can be
 * rewritten freely without disturbing other tests.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDevServer, type DevHandle } from "../src/dev";

/** The fixture body, mirroring fixtures/serve-sample.ts (greet/subtract/slowEcho/boom/identity). */
function fixtureSource(greeting: string): string {
  return `
/**
 * Greets a person by name and age.
 * @param name - The person's name
 * @param age - The person's age in years
 */
export function greet(name: string, age: number): string {
  return \`${greeting} \${name}, age \${age}\`;
}

/**
 * Subtracts b from a.
 * @param a - The minuend
 * @param b - The subtrahend
 */
export function subtract(a: number, b: number): number {
  return a - b;
}

/**
 * Echoes a message after a tick.
 * @param msg - The message to echo back
 */
export async function slowEcho(msg: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return \`echo: \${msg}\`;
}

/**
 * Always throws.
 * @param detail - Text folded into the thrown message
 */
export function boom(detail: string): string {
  throw new Error(\`boom: \${detail}\`);
}

/** Unbound generic — generateTools excludes it (fail-loud). */
export function identity<T>(value: T): T {
  return value;
}
`;
}

let tmpDir: string;
let fixturePath: string;
let handle: DevHandle;
let base: string;

async function getJson(p: string): Promise<any> {
  const res = await fetch(`${base}${p}`);
  return res.json();
}

async function postCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

/** Low-level request so we can set arbitrary Host / Origin / Content-Type headers. */
function rawRequest(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  // Keep the dev server's startup/reload logging out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gen-dev-"));
  fixturePath = path.join(tmpDir, "dev-sample.ts");
  fs.writeFileSync(fixturePath, fixtureSource("Hello"));

  handle = await startDevServer({ file: fixturePath, port: 0 });
  base = handle.url; // ends with "/"
}, 30_000);

afterAll(async () => {
  await handle?.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  vi.restoreAllMocks();
});

describe("mcp-gen dev — Stage A HTTP API", () => {
  it("binds 127.0.0.1 only", () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("GET / serves the self-contained UI HTML that references the API", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain("/api/tools");
    expect(html).toContain("/api/call");
    expect(html).toContain("/api/events");
  });

  it("GET /api/tools lists convertible tools and excludes the unbound generic (in errors)", async () => {
    const body = await getJson("api/tools");
    expect(body.ok).toBe(true);

    const names = body.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["boom", "greet", "slowEcho", "subtract"]);
    expect(names).not.toContain("identity");

    // identity is fail-loud excluded → present in errors with its reason.
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.some((e: any) => e.function === "identity")).toBe(true);

    // The inputSchema is carried through for the UI to render a form from.
    const greet = body.tools.find((t: any) => t.name === "greet");
    expect(greet.inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
  });

  it("POST /api/call greet returns the result via the shared seam", async () => {
    const body = await postCall("greet", { name: "Ada", age: 36 });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("Hello Ada, age 36");
  });

  it("POST /api/call subtract preserves parameter order even when args arrive reversed", async () => {
    const body = await postCall("subtract", { b: 3, a: 10 });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("7");
  });

  it("POST /api/call boom returns isError and the server stays up", async () => {
    const body = await postCall("boom", { detail: "kaboom" });
    expect(body.ok).toBe(false);
    expect(body.isError).toBe(true);
    expect(body.message).toContain("boom: kaboom");

    // The server survived the throw and still serves a subsequent call.
    const after = await postCall("greet", { name: "Bob", age: 7 });
    expect(after.ok).toBe(true);
    expect(after.result).toBe("Hello Bob, age 7");
  });

  it("rejects a foreign Host header (DNS-rebinding protection)", async () => {
    const r = await rawRequest({ method: "GET", path: "/api/tools", headers: { host: "evil.example.com" } });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/host|rebinding/i);
  });

  it("rejects a cross-origin request (CSRF protection)", async () => {
    const r = await rawRequest({
      method: "GET",
      path: "/api/tools",
      headers: { host: new URL(base).host, origin: "http://evil.example.com" },
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/cross-origin/i);
  });

  it("allows a same-origin request whose Origin matches the server", async () => {
    const origin = base.replace(/\/$/, "");
    const r = await rawRequest({
      method: "GET",
      path: "/api/tools",
      headers: { host: new URL(base).host, origin },
    });
    expect(r.status).toBe(200);
  });

  it("rejects a non-JSON POST /api/call (CORS simple-request CSRF vector)", async () => {
    const r = await rawRequest({
      method: "POST",
      path: "/api/call",
      headers: { host: new URL(base).host, "content-type": "text/plain" },
      body: JSON.stringify({ tool: "greet", args: { name: "x", age: 1 } }),
    });
    expect(r.status).toBe(415);
  });

  it("SSE reload fires after an edit AND a subsequent call runs the NEW code (cache invalidation)", async () => {
    // Subscribe to the SSE stream and resolve once a `reload` event arrives.
    const reloadSeen = new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}api/events`, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.includes("event: reload")) {
            req.destroy();
            resolve();
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      // Safety timeout so a watcher that never fires fails loudly, not hangs.
      setTimeout(() => {
        req.destroy();
        reject(new Error("timed out waiting for SSE reload"));
      }, 15_000);
    });

    // Give the SSE connection a moment to attach before we trigger the change.
    await new Promise((r) => setTimeout(r, 100));

    // Rewrite the fixture on disk: greet now says "Howdy".
    fs.writeFileSync(fixturePath, fixtureSource("Howdy"));

    await reloadSeen;

    // The post-reload call runs the new code — proof the module cache was busted.
    const body = await postCall("greet", { name: "Ada", age: 36 });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("Howdy Ada, age 36");
  }, 30_000);
});
