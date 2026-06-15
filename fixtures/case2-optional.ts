/**
 * Searches for items matching a query.
 * @param query - The search query
 * @param limit - Max number of results (defaults to 10)
 */
export function search(query: string, limit?: number): string[] {
  return [query].slice(0, limit ?? 10);
}
