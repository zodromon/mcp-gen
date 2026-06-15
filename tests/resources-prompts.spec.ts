/**
 * v1.1.0: resource/prompt inference + the shared callable seam.
 *
 * Two layers, both at the library level (no HTTP):
 *   1. generateTools classification/inference — the one disambiguation rule
 *      (untagged → tool; @resource → resource/template; @prompt → prompt), the
 *      template var↔param matching, and the fail-loud contract for the cases that
 *      can't be converted.
 *   2. loadCallableTools readResource/getPrompt — that a read/get runs the
 *      function through the SAME path a tool uses, with mime inference, URI-var
 *      validation, and prompt-message shaping (string vs message array).
 *
 * serve + a real SDK client are exercised end-to-end in resources-prompts-e2e.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateTools } from "../src/generate";
import { loadCallableTools } from "../src/callable";
import { ROOT } from "./helpers";

const fixture = (name: string) => path.join(ROOT, "fixtures", name);
const CLEAN = fixture("resources-prompts-sample.ts");
const FAILLOUD = fixture("resource-prompt-failloud.ts");

describe("classification: the one disambiguation rule", () => {
  const r = generateTools(CLEAN);

  it("an untagged function stays a tool (and is absent from resources/prompts)", () => {
    expect(r.tools.map((t) => t.name)).toEqual(["greet"]);
    expect(r.resources.some((x) => x.name === "greet")).toBe(false);
    expect(r.resourceTemplates.some((x) => x.name === "greet")).toBe(false);
    expect(r.prompts.some((x) => x.name === "greet")).toBe(false);
    // The tool itself is unchanged: a plain string param with its @param doc.
    expect(r.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "Who to greet" } },
      required: ["name"],
    });
    expect(r.errors).toEqual([]);
  });

  it("@resource users://{id} on (id: string) → a template with id as the var", () => {
    const t = r.resourceTemplates.find((x) => x.name === "getUser")!;
    expect(t, "getUser must be a resource template").toBeDefined();
    expect(t.uriTemplate).toBe("users://{id}");
    expect(t.variables).toEqual(["id"]);
    // The template's inputSchema reuses the tool type engine + @param docs, so
    // the extracted URI value can be validated with the tool-arg validator.
    expect(t.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string", description: "The user id" } },
      required: ["id"],
    });
  });

  it("@resource with no template vars → a static resource", () => {
    const names = r.resources.map((x) => x.uri).sort();
    expect(names).toEqual(["config://app", "info://build"]);
    // No template = not a template.
    expect(r.resourceTemplates.some((x) => x.name === "appConfig")).toBe(false);
  });

  it("@mime overrides the resource mime type; otherwise it is inferred at read", () => {
    const buildInfo = r.resources.find((x) => x.name === "buildInfo")!;
    const appConfig = r.resources.find((x) => x.name === "appConfig")!;
    expect(buildInfo.mimeType).toBe("text/plain");
    expect(appConfig.mimeType).toBeUndefined();
  });

  it("@prompt → arguments derived from params (name + @param desc, required from non-optional)", () => {
    const review = r.prompts.find((x) => x.name === "reviewPrompt")!;
    expect(review, "reviewPrompt must be a prompt").toBeDefined();
    expect(review.arguments).toEqual([
      { name: "language", required: true, description: "The programming language" },
      { name: "code", required: true, description: "The code to review" },
    ]);
  });
});

describe("fail-loud: unconvertible @resource/@prompt are excluded and reported", () => {
  const r = generateTools(FAILLOUD);

  it("a clean tool sibling still emits", () => {
    expect(r.tools.map((t) => t.name)).toEqual(["cleanTool"]);
  });

  it("never half-registers a failed primitive", () => {
    expect(r.resources).toEqual([]);
    expect(r.resourceTemplates).toEqual([]);
    expect(r.prompts).toEqual([]);
  });

  it("a template var with no matching param is an error", () => {
    const err = r.errors.find((e) => e.function === "badTemplate");
    expect(err, "badTemplate must be reported").toBeDefined();
    expect(err!.message).toMatch(/\{id\}.*no matching/i);
  });

  it("a function tagged both @resource and @prompt is an error", () => {
    const err = r.errors.find((e) => e.function === "ambiguous");
    expect(err, "ambiguous must be reported").toBeDefined();
    expect(err!.message).toMatch(/both @resource and @prompt/i);
  });

  it("an @resource with no URI is an error", () => {
    const err = r.errors.find((e) => e.function === "noUri");
    expect(err, "noUri must be reported").toBeDefined();
    expect(err!.message).toMatch(/requires a URI/i);
  });
});

describe("callable seam: reading resources through the shared path", () => {
  it("a static resource returning an object → application/json", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.readResource("config://app");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.mimeType).toBe("application/json");
    expect(JSON.parse(out.text)).toEqual({ theme: "dark", version: "1.1.0" });
  });

  it("a static resource with @mime override → text/plain with the raw string body", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.readResource("info://build");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.mimeType).toBe("text/plain");
    expect(out.text).toBe("mcp-gen build 1.1.0");
  });

  it("a resource template extracts the URI var, validates it, and runs the function", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.readResource("users://42");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.mimeType).toBe("application/json");
    expect(JSON.parse(out.text)).toEqual({ id: "42", name: "User 42" });
  });

  it("an unmatched URI → unknownResource (not a crash)", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.readResource("nope://nothing");
    expect(out.kind).toBe("unknownResource");
  });
});

describe("callable seam: getting prompts through the shared path", () => {
  it("a string return → a single user text message", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.getPrompt("reviewPrompt", { language: "TypeScript", code: "const x = 1;" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[0].content).toMatchObject({ type: "text" });
    expect(JSON.stringify(out.messages[0].content)).toMatch(/TypeScript/);
  });

  it("a message-array return is passed through as-is", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.getPrompt("chatPrompt", { topic: "MCP" });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(JSON.stringify(out.messages)).toMatch(/MCP/);
  });

  it("a missing required argument → invalidParams (fn NOT called)", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.getPrompt("reviewPrompt", { code: "x" });
    expect(out.kind).toBe("invalidParams");
  });

  it("an unknown prompt name → unknownPrompt", async () => {
    const bundle = await loadCallableTools(CLEAN);
    const out = await bundle.getPrompt("nope", {});
    expect(out.kind).toBe("unknownPrompt");
  });

  it("a return shape we can't handle → invalidReturn (fail-loud)", async () => {
    const bundle = await loadCallableTools(fixture("prompt-bad-return.ts"));
    const out = await bundle.getPrompt("badReturn", {});
    expect(out.kind).toBe("invalidReturn");
  });
});
