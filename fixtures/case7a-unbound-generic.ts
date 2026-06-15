export function ok(x: string): string {
  return x;
}

export function wrap<T>(value: T, label: string): { label: string; value: T } {
  return { label, value };
}
