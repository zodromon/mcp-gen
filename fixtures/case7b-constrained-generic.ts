export function pluckId<T extends { id: string }>(item: T): string {
  return item.id;
}

export function pluckIdConcrete(item: { id: string }): string {
  return item.id;
}
