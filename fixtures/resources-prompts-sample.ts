// Fixture exercising the resource/prompt inference (v1.1.0). Each export probes
// one classification + runtime behavior:
//   - greet        untagged, stays a TOOL (proves backward-compat coexistence)
//   - getUser      resource TEMPLATE (users://{id} on the `id` param, JSON body)
//   - appConfig    static RESOURCE (config://app, no vars, JSON body)
//   - buildInfo    static RESOURCE (info://build, plain-text mime override)
//   - reviewPrompt prompt whose string return becomes a single user message
//   - chatPrompt   prompt whose message-array return is passed through as-is

/**
 * Greets a person by name. Untagged → a tool, unchanged.
 * @param name - Who to greet
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

/**
 * Read a user record by id. A resource template — {id} matches the `id` param.
 * @resource users://{id}
 * @param id - The user id
 */
export function getUser(id: string): { id: string; name: string } {
  return { id, name: `User ${id}` };
}

/**
 * The current application configuration. A static resource (no template vars);
 * the object return serializes to application/json.
 * @resource config://app
 */
export function appConfig(): { theme: string; version: string } {
  return { theme: "dark", version: "1.1.0" };
}

/**
 * Server build info, served as plain text via an explicit mime override.
 * @resource info://build
 * @mime text/plain
 */
export function buildInfo(): string {
  return "mcp-gen build 1.1.0";
}

/**
 * A code-review prompt. A string return becomes a single user text message.
 * @prompt
 * @param language - The programming language
 * @param code - The code to review
 */
export function reviewPrompt(language: string, code: string): string {
  return `Please review this ${language} code:\n\n${code}`;
}

/**
 * A two-message conversation prompt. The array of { role, content } messages is
 * passed through to prompts/get as-is.
 * @prompt
 * @param topic - The discussion topic
 */
export function chatPrompt(topic: string) {
  return [
    { role: "assistant", content: { type: "text", text: `Let's discuss ${topic}.` } },
    { role: "user", content: { type: "text", text: `What should I know about ${topic}?` } },
  ];
}
