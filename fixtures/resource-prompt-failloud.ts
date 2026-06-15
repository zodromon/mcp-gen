/**
 * Fixture for the resource/prompt fail-loud contract: each export is
 * unconvertible and must be EXCLUDED (absent from resources/templates/prompts)
 * and recorded in `errors` — never half-registered. A clean sibling proves the
 * failures don't poison the rest of the file.
 */

/**
 * A clean tool sibling — must still be emitted alongside the failures.
 * @param x - A value
 */
export function cleanTool(x: string): string {
  return x;
}

/**
 * Template variable {id} has no matching parameter (the param is `wrongName`).
 * @resource widgets://{id}
 * @param wrongName - Not a match for {id}
 */
export function badTemplate(wrongName: string): string {
  return wrongName;
}

/**
 * Tagged both @resource and @prompt — ambiguous, excluded.
 * @resource foo://bar
 * @prompt
 */
export function ambiguous(): string {
  return "x";
}

/**
 * A resource tag with no URI is unconvertible and must be excluded.
 * @resource
 */
export function noUri(): string {
  return "x";
}
