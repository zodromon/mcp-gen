/**
 * `mcp-gen dev <file.ts> [--port N] [--tsconfig <path>]` — a type-aware live
 * playground for the MCP server a TypeScript file defines.
 *
 * It watches the file, regenerates the tool surface on every save, and serves a
 * tiny localhost web UI that renders an input form per tool, runs the tool on
 * demand, and shows the result, the generated schema, and the raw JSON-RPC.
 *
 * The non-negotiable invariant: the playground executes a tool EXACTLY the way
 * `serve` would. Both go through the shared `loadCallableTools` seam
 * (src/callable.ts) — same jiti loader, same named→positional dispatch, same
 * validate→await→throw→isError handling. dev is just a second front-end; it
 * cannot diverge from the served runtime because it runs the same code.
 *
 * Security: this endpoint executes arbitrary local code on request, so it binds
 * 127.0.0.1 ONLY — never a public interface.
 *
 * The HTTP API (Node http, no framework):
 *   - GET  /            → the inlined web UI (Stage B).
 *   - GET  /api/tools   → the current tool surface: servable tools (name,
 *                         description, inputSchema) + errors/warnings, so the UI
 *                         can show what's broken.
 *   - POST /api/call    → { tool, args } → invoke via the shared seam; returns
 *                         { ok, result } or { ok:false, isError:true, message }.
 *                         A throwing tool becomes isError, never a 500.
 *   - GET  /api/events  → SSE stream; a `reload` event fires whenever the file
 *                         changes and the surface is regenerated.
 *
 * On a file change the watcher re-runs the seam (which re-imports the module with
 * jiti's caches disabled, so subsequent calls run the NEW code), then emits the
 * SSE reload. A file-level parse failure does NOT crash the server — it is kept
 * up and surfaced through /api/tools.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCallableTools, NoServableToolsError, type CallableBundle } from "./callable";
import { renderDevUi } from "./dev-ui";

export interface DevOptions {
  /** Path to the .ts file whose exported functions become tools. */
  file: string;
  /** Port to listen on. 0 selects an ephemeral port (used by tests). */
  port?: number;
  /** Explicit tsconfig.json path forwarded to generateTools (else discovered). */
  tsconfig?: string;
}

export interface DevHandle {
  /** The playground URL (always on 127.0.0.1). */
  url: string;
  /** The actual bound port (resolved when port 0 is requested). */
  port: number;
  /** Shut the server, watcher, and SSE streams down with no orphaned handles. */
  close: () => Promise<void>;
}

/** The current tool surface. `ok:false` is a file-level parse failure that the
 *  server survives — it stays up and reports the error via /api/tools. */
type DevState =
  | { ok: true; bundle: CallableBundle }
  | { ok: false; error: string };

const DEFAULT_DEV_PORT = 4000;
const RELOAD_DEBOUNCE_MS = 150;
/** Periodic SSE comment so half-open peers surface (broken pipe) and get reaped. */
const SSE_HEARTBEAT_MS = 25_000;
/** Cap concurrent SSE streams — a drive-by page can't exhaust fds/memory. */
const MAX_SSE_CLIENTS = 50;

/** Bind 127.0.0.1 only — this endpoint runs arbitrary local code on request. */
const BIND_HOST = "127.0.0.1";

/**
 * Loopback binding alone does NOT make this endpoint safe from the developer's
 * OWN browser: a malicious page they visit can POST to 127.0.0.1 (CSRF), and a
 * DNS-rebinding attack can make attacker.com resolve to 127.0.0.1 and read
 * responses. We defend with a Host-header allowlist (rebinding) + an Origin
 * check (cross-site) — the same protections the MCP SDK transport offers.
 */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** Source extensions whose change in the entry's directory triggers a reload. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);

export async function startDevServer(options: DevOptions): Promise<DevHandle> {
  const absFile = path.resolve(process.cwd(), options.file);
  const port = options.port ?? DEFAULT_DEV_PORT;

  // Initial load through the shared seam. A throw here is a file-level failure
  // (not found / unparseable) or a module that throws at import — the CLI maps
  // it to exit 2, exactly like serve's startup.
  const initialBundle = await loadCallableTools(absFile, { tsconfig: options.tsconfig, freshModuleCache: true });

  // Nothing servable at STARTUP is exit 2, mirroring serve. (A reload that later
  // empties the surface is different — see reload(): the server stays up so the
  // UI can show what broke.)
  if (initialBundle.tools.length === 0) {
    throw new NoServableToolsError(
      `No servable tools in ${options.file}: every exported function was excluded ` +
        `by the generator or had no matching runtime export.`,
    );
  }
  let state: DevState = { ok: true, bundle: initialBundle };

  const sseClients = new Set<ServerResponse>();

  const broadcastReload = (): void => {
    const payload = JSON.stringify({ ok: state.ok });
    for (const res of sseClients) {
      try {
        res.write(`event: reload\ndata: ${payload}\n\n`);
      } catch {
        // A dead client; it will be cleaned up by its own close handler.
      }
    }
  };

  // Re-run the seam on a save. This re-imports the module with jiti's caches
  // disabled, so the next /api/call runs the edited code (cache invalidation).
  // A parse failure is caught: the server stays up and surfaces it. A monotonic
  // generation token guards against two reloads (separate save bursts) resolving
  // out of order — only the newest may commit `state`, so we never regress to an
  // older edit's surface.
  let reloadGen = 0;
  const reload = async (): Promise<void> => {
    const gen = ++reloadGen;
    let next: DevState;
    try {
      const bundle = await loadCallableTools(absFile, { tsconfig: options.tsconfig, freshModuleCache: true });
      next = { ok: true, bundle };
    } catch (err) {
      next = { ok: false, error: errMessage(err) };
    }
    if (gen !== reloadGen) return; // a newer reload superseded us; let it win.
    state = next;
    if (state.ok) {
      console.error(
        `reloaded ${state.bundle.toolNames.length} tool${state.bundle.toolNames.length === 1 ? "" : "s"}: ${state.bundle.toolNames.join(", ")}`,
      );
    } else {
      console.error(`reload failed (server still up): ${state.error}`);
    }
    broadcastReload();
  };

  // Watch the entry file's directory and react to any source file in it — so
  // editing a same-directory dependency (not just the entry) reloads too.
  // Watching the directory is also more reliable than a single-file watch for
  // in-place editor writes (especially on Windows). Debounce coalesces the burst
  // of events a single save produces. (Dependencies in OTHER directories are out
  // of scope for this "watch the entry file and its directory" strategy.)
  const dir = path.dirname(absFile);
  const base = path.basename(absFile);
  let debounce: NodeJS.Timeout | undefined;
  const scheduleReload = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void reload();
    }, RELOAD_DEBOUNCE_MS);
  };
  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename) {
      const name = path.basename(filename.toString());
      // React to the entry file or any sibling source file; ignore other noise.
      if (name !== base && !SOURCE_EXTENSIONS.has(path.extname(name))) return;
    }
    scheduleReload();
  });

  // Heartbeat: a periodic SSE comment so silently-dead peers fail a write and get
  // reaped (the 'close' handler removes them). unref so it never holds the loop.
  const heartbeat = setInterval(() => {
    for (const r of sseClients) {
      try {
        r.write(`: ping\n\n`);
      } catch {
        /* dead client; its close handler cleans up */
      }
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, {
      getState: () => state,
      boundPort: () => boundPort,
      addSseClient: (r) => {
        if (sseClients.size >= MAX_SSE_CLIENTS) return false;
        sseClients.add(r);
        r.on("close", () => sseClients.delete(r));
        return true;
      },
    }).catch((err: unknown) => {
      // Any unexpected handler error must not take the server down.
      console.error(`error handling request: ${errMessage(err)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ ok: false, isError: true, message: errMessage(err) }));
    });
  });

  const boundPort = await listen(httpServer, port);
  const url = `http://${BIND_HOST}:${boundPort}/`;

  console.error(`mcp-gen dev playground on ${url}`);
  if (state.ok) {
    console.error(
      `serving ${state.bundle.toolNames.length} tool${state.bundle.toolNames.length === 1 ? "" : "s"}: ${state.bundle.toolNames.join(", ")}`,
    );
  }

  const close = async (): Promise<void> => {
    if (debounce) clearTimeout(debounce);
    clearInterval(heartbeat);
    watcher.close();
    for (const r of sseClients) {
      try {
        r.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { url, port: boundPort, close };
}

interface HandlerDeps {
  getState: () => DevState;
  boundPort: () => number;
  /** Register an SSE stream; false when the connection cap is reached. */
  addSseClient: (res: ServerResponse) => boolean;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const reqUrl = new URL(req.url ?? "/", `http://${BIND_HOST}`);
  const pathname = reqUrl.pathname;
  const method = req.method ?? "GET";

  // SECURITY: reject DNS-rebinding (foreign Host) and cross-site (foreign Origin)
  // requests before doing ANY work — this endpoint runs arbitrary local code, so
  // loopback binding alone is not enough against the developer's own browser.
  const port = deps.boundPort();
  if (!hostAllowed(req.headers.host, port)) {
    sendJson(res, 403, { ok: false, isError: true, message: "forbidden host (DNS-rebinding protection)" });
    return;
  }
  if (!originAllowed(req.headers.origin, port)) {
    sendJson(res, 403, { ok: false, isError: true, message: "forbidden cross-origin request" });
    return;
  }

  if (method === "GET" && pathname === "/") {
    sendHtml(res, renderDevUi());
    return;
  }

  if (method === "GET" && pathname === "/api/tools") {
    sendJson(res, 200, toolsPayload(deps.getState()));
    return;
  }

  if (method === "POST" && pathname === "/api/call") {
    // Require application/json: blocks the CORS "simple request" CSRF vector (a
    // cross-site form/text-plain POST), since a real JSON content-type forces a
    // preflight we never approve.
    const ct = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") {
      sendJson(res, 415, { ok: false, isError: true, message: "Content-Type must be application/json" });
      return;
    }
    await handleCall(req, res, deps.getState());
    return;
  }

  if (method === "GET" && pathname === "/api/events") {
    handleEvents(res, deps);
    return;
  }

  sendJson(res, 404, { ok: false, isError: true, message: `Not found: ${method} ${pathname}` });
}

/**
 * Host-header allowlist: only loopback names on the port we actually bound.
 * Defeats DNS rebinding — a request whose Host is attacker.com (rebound to
 * 127.0.0.1) is rejected even though the socket accepted the connection.
 */
function hostAllowed(host: string | undefined, boundPort: number): boolean {
  if (!host) return false; // HTTP/1.1 requires Host; a missing one is suspicious.
  const { hostname, port } = splitHostPort(host);
  if (!ALLOWED_HOSTNAMES.has(hostname)) return false;
  if (port !== "" && Number(port) !== boundPort) return false;
  return true;
}

/**
 * Origin check: requests with NO Origin (top-level navigation, server-side
 * fetch, same-origin EventSource) are allowed; a present Origin must be one of
 * our loopback origins on the bound port. Defeats cross-site POST/GET from a
 * page the developer happens to be visiting.
 */
function originAllowed(origin: string | undefined, boundPort: number): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) return false;
  if (url.port !== "" && Number(url.port) !== boundPort) return false;
  return true;
}

/** Split a Host/authority value into hostname + port, handling [::1]:port. */
function splitHostPort(host: string): { hostname: string; port: string } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host, port: "" };
    const hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    return { hostname, port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return { hostname: host, port: "" };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

/** Build the /api/tools body: servable tools + fail-loud errors/warnings, or
 *  the file-level error when the file currently fails to parse/load. */
function toolsPayload(state: DevState): Record<string, unknown> {
  if (!state.ok) {
    return { ok: false, fileError: state.error, tools: [], errors: [], warnings: [] };
  }
  const { bundle } = state;
  // Fold "no matching export" skips into warnings — the UI's greyed-out list is
  // driven by `errors` (the fail-loud generator exclusions).
  const warnings = [
    ...bundle.warnings,
    ...bundle.skipped.map((s) => `${s.name}: ${s.reason} — not served.`),
  ];
  return {
    ok: true,
    file: bundle.file,
    tools: bundle.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    errors: bundle.errors,
    warnings,
  };
}

/** POST /api/call → invoke through the shared seam, map to the dev JSON shape. */
async function handleCall(req: IncomingMessage, res: ServerResponse, state: DevState): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, isError: true, message: `invalid JSON body: ${errMessage(err)}` });
    return;
  }
  const { tool, args } = (body ?? {}) as { tool?: unknown; args?: unknown };
  if (typeof tool !== "string" || tool.length === 0) {
    sendJson(res, 400, { ok: false, isError: true, message: "missing or invalid 'tool' field" });
    return;
  }
  if (!state.ok) {
    sendJson(res, 200, {
      ok: false,
      isError: true,
      message: `file is not loadable: ${state.error}`,
    });
    return;
  }
  const callArgs = (args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const outcome = await state.bundle.invoke(tool, callArgs);
  if (outcome.kind === "ok") {
    sendJson(res, 200, { ok: true, result: outcome.text });
  } else {
    // toolError, unknownTool, invalidParams all map to the single error shape —
    // a throwing tool becomes isError, never a 500 that kills the server.
    sendJson(res, 200, { ok: false, isError: true, kind: outcome.kind, message: outcome.message });
  }
}

/** GET /api/events → an SSE stream that pushes a `reload` event on each save. */
function handleEvents(res: ServerResponse, deps: HandlerDeps): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // No buffering by any reverse proxy (defensive; we only bind localhost).
    "x-accel-buffering": "no",
  });
  res.write(`: connected\n\n`);
  // Honor the connection cap — refuse (and close) once too many streams are open.
  if (!deps.addSseClient(res)) {
    res.write(`: too many event streams; closing\n\n`);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 5 * 1024 * 1024; // generous; a playground call is tiny
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listen(httpServer: HttpServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    // Bind 127.0.0.1 ONLY — never expose this arbitrary-code endpoint publicly.
    httpServer.listen(port, BIND_HOST, () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not determine the listening port"));
    });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
