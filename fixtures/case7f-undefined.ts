// A parameter typed exactly `undefined` has no JSON Schema representation. It
// must be a hard error (function excluded), NOT silently emitted with a
// `$comment` placeholder in an input position.
export function cleanFn(x: string): void {
  void x;
}

export function undefinedParam(x: undefined): void {
  void x;
}
