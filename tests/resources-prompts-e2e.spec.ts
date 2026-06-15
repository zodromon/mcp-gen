/**
 * E2E for resources + prompts over `mcp-gen serve`: start the live MCP server in
 * process on an ephemeral port, connect a real SDK Client over Streamable HTTP,
 * and exercise resources/list, resources/templates/list, resources/read,
 * prompts/list, and prompts/get against the inferred primitives.
 *
 * What this pins:
 *   - tools still work alongside resources/prompts (greet is served).
 *   - resources/list & resources/templates/list expose the inferred URIs.
 *   - resources/read runs a STATIC resource (object → application/json) and a
 *     TEMPLATED resource (users://42 → the id is extracted, validated, passed in).
 *   - the @mime override flows through (info://build → text/plain).
 *   - prompts/list exposes the inferred arguments; prompts/get runs the function
 *     and shapes a string return into a single user message.
 *
 * The client connects directly to the served server — no proxy in between.
 */
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type ServeHandle } from "../src/serve";
import { ROOT } from "./helpers";

const FIXTURE = path.join(ROOT, "fixtures", "resources-prompts-sample.ts");

/** The text variant of a resource content block (mcp-gen never emits blobs). */
type TextContent = { uri: string; mimeType?: string; text: string };

let handle: ServeHandle;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeAll(async () => {
  // Keep serve's startup logging out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});

  handle = await startServer({ file: FIXTURE, port: 0 });
  client = new Client({ name: "resources-prompts-e2e", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(new URL(handle.url));
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await handle?.close();
  vi.restoreAllMocks();
});

describe("mcp-gen serve — resources & prompts E2E over Streamable HTTP", () => {
  it("still serves tools alongside resources/prompts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["greet"]);
  });

  it("advertises the resources and prompts capabilities", () => {
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
  });

  it("resources/list exposes the static resources", async () => {
    const { resources } = await client.listResources();
    const byUri = Object.fromEntries(resources.map((r) => [r.uri, r]));
    expect(Object.keys(byUri).sort()).toEqual(["config://app", "info://build"]);
    expect(byUri["info://build"].mimeType).toBe("text/plain");
  });

  it("resources/templates/list exposes the resource template", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["users://{id}"]);
  });

  it("resources/read runs a static resource (object → application/json)", async () => {
    const res = await client.readResource({ uri: "config://app" });
    expect(res.contents).toHaveLength(1);
    const content = res.contents[0] as TextContent;
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text)).toEqual({ theme: "dark", version: "1.1.0" });
  });

  it("resources/read honors the @mime override (text/plain body)", async () => {
    const res = await client.readResource({ uri: "info://build" });
    const content = res.contents[0] as TextContent;
    expect(content.mimeType).toBe("text/plain");
    expect(content.text).toBe("mcp-gen build 1.1.0");
  });

  it("resources/read runs a TEMPLATED resource, extracting and passing the id", async () => {
    const res = await client.readResource({ uri: "users://42" });
    const content = res.contents[0] as TextContent;
    expect(content.uri).toBe("users://42");
    expect(content.mimeType).toBe("application/json");
    expect(JSON.parse(content.text)).toEqual({ id: "42", name: "User 42" });
  });

  it("prompts/list exposes the inferred prompt arguments", async () => {
    const { prompts } = await client.listPrompts();
    const byName = Object.fromEntries(prompts.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["chatPrompt", "reviewPrompt"]);
    expect(byName["reviewPrompt"].arguments).toEqual([
      { name: "language", description: "The programming language", required: true },
      { name: "code", description: "The code to review", required: true },
    ]);
  });

  it("prompts/get runs the function and shapes a string return into a user message", async () => {
    const res = await client.getPrompt({
      name: "reviewPrompt",
      arguments: { language: "TypeScript", code: "const x = 1;" },
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
    expect(res.messages[0].content).toMatchObject({ type: "text" });
    expect(JSON.stringify(res.messages[0].content)).toMatch(/TypeScript/);
  });

  it("prompts/get passes a message-array return through as-is", async () => {
    const res = await client.getPrompt({ name: "chatPrompt", arguments: { topic: "MCP" } });
    expect(res.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(JSON.stringify(res.messages)).toMatch(/MCP/);
  });
});
