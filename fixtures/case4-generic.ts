/**
 * Fetches a resource and parses it as T.
 * @param url - The URL to fetch
 */
export function fetchData<T>(url: string): Promise<T> {
  return fetch(url).then((r) => r.json() as Promise<T>);
}

/**
 * Generic in an input position.
 */
export function wrap<T>(value: T, label: string): { label: string; value: T } {
  return { label, value };
}

/**
 * Constrained generic in an input position.
 */
export function pluckId<T extends { id: string }>(item: T): string {
  return item.id;
}
