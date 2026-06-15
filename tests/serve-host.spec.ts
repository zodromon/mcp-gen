/**
 * The serve bind-address security default and its `--host` opt-in.
 *
 * What this pins:
 *   - parseServerArgs: serve accepts `--host <addr>` / `--host=<addr>` and
 *     surfaces it; dev REJECTS `--host` (it is hard-bound to 127.0.0.1).
 *   - isLoopbackHost: the classifier that decides "safe to bind silently".
 *   - startServer: binds 127.0.0.1 by DEFAULT (reachable over loopback, no
 *     exposure warning), and a non-loopback host sets the bind address AND fires
 *     a loud one-line stderr warning.
 *   - dev still binds 127.0.0.1 only — unaffected by the serve-only flag.
 *
 * The non-loopback runtime case binds 0.0.0.0 on an ephemeral port and closes
 * immediately; the parse-level assertions cover the flag without needing a public
 * bind (per the task's "no need to actually bind a public interface in CI").
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, isLoopbackHost, type ServeHandle } from "../src/serve";
import { startDevServer, type DevHandle } from "../src/dev";
import { parseServerArgs } from "../src/cli";
import { ROOT } from "./helpers";

const FIXTURE = path.join(ROOT, "fixtures", "serve-sample.ts");

/** The exposure warning serve prints when a non-loopback host is chosen. */
const EXPOSURE_WARNING = /reachable from other machines|NO authentication/i;

// --------------------------------------------------------------------------
// parseServerArgs — the shared parser, scoped so only serve accepts --host
// --------------------------------------------------------------------------

describe("parseServerArgs — --host is serve-only", () => {
  const serve = (argv: string[]) => parseServerArgs(argv, 3000, { acceptHost: true });
  const dev = (argv: string[]) => parseServerArgs(argv, 4000); // acceptHost defaults false

  it("serve: no --host leaves host undefined (default applied downstream)", () => {
    const p = serve(["tools.ts"]);
    expect(p.error).toBeUndefined();
    expect(p.file).toBe("tools.ts");
    expect(p.host).toBeUndefined();
    expect(p.port).toBe(3000);
  });

  it("serve: --host 0.0.0.0 sets the bind address (and keeps the file)", () => {
    const p = serve(["tools.ts", "--host", "0.0.0.0"]);
    expect(p.error).toBeUndefined();
    expect(p.host).toBe("0.0.0.0");
    expect(p.file).toBe("tools.ts");
  });

  it("serve: --host=<addr> form is parsed; the address is never mistaken for the file", () => {
    const p = serve(["--host=192.168.1.50", "tools.ts"]);
    expect(p.error).toBeUndefined();
    expect(p.host).toBe("192.168.1.50");
    expect(p.file).toBe("tools.ts");
  });

  it("serve: --host composes with --port and --tsconfig in any order", () => {
    const p = serve(["--port", "8080", "--host", "0.0.0.0", "--tsconfig", "tsconfig.json", "tools.ts"]);
    expect(p.error).toBeUndefined();
    expect(p.port).toBe(8080);
    expect(p.host).toBe("0.0.0.0");
    expect(p.tsconfig).toBe("tsconfig.json");
    expect(p.file).toBe("tools.ts");
  });

  it("serve: --host with no value is an error", () => {
    expect(serve(["tools.ts", "--host"]).error).toMatch(/--host requires an address/);
    expect(serve(["tools.ts", "--host="]).error).toMatch(/--host requires an address/);
  });

  it("dev: --host is rejected — dev is always loopback (both flag forms)", () => {
    expect(dev(["tools.ts", "--host", "0.0.0.0"]).error).toMatch(/not supported for dev/i);
    expect(dev(["tools.ts", "--host=0.0.0.0"]).error).toMatch(/not supported for dev/i);
  });

  it("dev: without --host parsing is unchanged (no host, default port)", () => {
    const p = dev(["tools.ts", "--port", "4100"]);
    expect(p.error).toBeUndefined();
    expect(p.host).toBeUndefined();
    expect(p.port).toBe(4100);
    expect(p.file).toBe("tools.ts");
  });
});

// --------------------------------------------------------------------------
// isLoopbackHost — the classifier
// --------------------------------------------------------------------------

describe("isLoopbackHost", () => {
  it("treats localhost, ::1, and all of 127.0.0.0/8 as loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "127.255.255.255", "localhost", "::1"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("treats wildcards and specific interfaces as NON-loopback (off-machine)", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", ""]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// startServer — default loopback bind + the non-loopback warning
// --------------------------------------------------------------------------

describe("startServer — bind address", () => {
  let stderr: string[];
  let handle: ServeHandle | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await handle?.close().catch(() => {});
    handle = undefined;
    client = undefined;
    vi.restoreAllMocks();
  });

  it("defaults to 127.0.0.1, is reachable over loopback, and prints no exposure warning", async () => {
    handle = await startServer({ file: FIXTURE, port: 0 });

    // The default bind is loopback — the security default this change introduces.
    expect(handle.host).toBe("127.0.0.1");

    // Reachable over loopback exactly as before (connect via explicit 127.0.0.1).
    client = new Client({ name: "serve-host-default", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    // The dangerous mode stayed silent because we never entered it.
    expect(stderr.join("\n")).not.toMatch(EXPOSURE_WARNING);
  }, 30_000);

  it("--host 0.0.0.0 binds the chosen address and fires the loud exposure warning", async () => {
    handle = await startServer({ file: FIXTURE, port: 0, host: "0.0.0.0" });

    expect(handle.host).toBe("0.0.0.0");

    // The warning fired, is one line, names the host, and flags the no-auth risk.
    const warning = stderr.find((l) => EXPOSURE_WARNING.test(l));
    expect(warning, `stderr:\n${stderr.join("\n")}`).toBeDefined();
    expect(warning!).toContain("0.0.0.0");
    expect(warning!).not.toContain("\n");

    // serve's behavior is otherwise unchanged: still reachable over loopback,
    // which 0.0.0.0 includes.
    client = new Client({ name: "serve-host-exposed", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  }, 30_000);
});

// --------------------------------------------------------------------------
// dev — unchanged: always loopback, no --host
// --------------------------------------------------------------------------

describe("startDevServer — still loopback-only", () => {
  it("binds 127.0.0.1 regardless of the serve-only flag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handle: DevHandle = await startDevServer({ file: FIXTURE, port: 0 });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally {
      await handle.close();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
