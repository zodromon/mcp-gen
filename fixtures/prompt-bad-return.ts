/**
 * A prompt that returns a number — a shape prompts/get cannot turn into
 * messages. The get must fail loud (invalidReturn) rather than emit garbage.
 * @prompt
 */
export function badReturn(): number {
  return 42;
}
