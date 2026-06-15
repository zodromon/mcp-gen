import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Run the CLI in a subprocess; returns parsed stdout JSON plus exit code and stderr. */
export function runCliSubprocess(args: string[]): {
  json: any;
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const tsxCli = require.resolve("tsx/cli");
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxCli, "generate-mcp-schemas.ts", ...args],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { json: safeParse(stdout), stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    const stdout: string = err.stdout ?? "";
    return {
      json: safeParse(stdout),
      stdout,
      stderr: err.stderr ?? "",
      exitCode: typeof err.status === "number" ? err.status : -1,
    };
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(stripBom(text));
  } catch {
    return undefined;
  }
}

/** Read a checked-in baseline from outputs/ (UTF-8 with BOM, written by PowerShell). */
export function readBaseline(name: string): any {
  return JSON.parse(stripBom(readFileSync(path.join(ROOT, "outputs", name), "utf8")));
}
