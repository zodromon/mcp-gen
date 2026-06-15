/**
 * Regression for the watcher's transitive-dependency coverage: editing a
 * same-directory imported file (not just the entry) must reload the surface, so
 * a subsequent /api/call runs the new code. The earlier watcher filtered every
 * event to the entry basename, which served stale code after a dependency edit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDevServer, type DevHandle } from "../src/dev";

let tmpDir: string;
let depPath: string;
let handle: DevHandle;
let base: string;

function postCall(tool: string, args: Record<string, unknown>): Promise<any> {
  return fetch(`${base}api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  }).then((r) => r.json());
}

function waitForReload(): Promise<void> {
  return new Promise((resolve, reject) => {
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
    setTimeout(() => {
      req.destroy();
      reject(new Error("timed out waiting for SSE reload after dependency edit"));
    }, 15_000);
  });
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gen-dev-deps-"));
  const entryPath = path.join(tmpDir, "entry.ts");
  depPath = path.join(tmpDir, "dep.ts");

  fs.writeFileSync(depPath, `export const WORD = "OLD";\n`);
  fs.writeFileSync(
    entryPath,
    `import { WORD } from "./dep";\n` +
      `/**\n * Tags a name with the imported WORD.\n * @param name - a name\n */\n` +
      `export function tag(name: string): string {\n  return WORD + ":" + name;\n}\n`,
  );

  handle = await startDevServer({ file: entryPath, port: 0 });
  base = handle.url;
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

describe("mcp-gen dev — watches same-directory dependencies", () => {
  it("serves the original value before any edit", async () => {
    const body = await postCall("tag", { name: "a" });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("OLD:a");
  });

  it("editing an imported sibling file reloads and the next call runs new code", async () => {
    const reloaded = waitForReload();
    await new Promise((r) => setTimeout(r, 100));

    fs.writeFileSync(depPath, `export const WORD = "NEW";\n`);

    await reloaded;

    const body = await postCall("tag", { name: "a" });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("NEW:a");
  }, 30_000);
});
