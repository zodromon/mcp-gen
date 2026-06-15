export const a = (x: string, limit?: number): string[] => [];

export const b = function (x: string): void {};

export const c = async (x: string): Promise<number> => 0;

/**
 * Echoes a string.
 * @param x - The input string
 */
export const d = (x: string) => x;

export default function named(x: string) {}
