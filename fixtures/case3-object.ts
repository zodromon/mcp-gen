/**
 * Creates a user account.
 * @param opts - The user creation options
 */
export function createUser(opts: { email: string; role: "admin" | "user" }): { id: string } {
  return { id: `${opts.role}:${opts.email}` };
}

/**
 * Variant with nesting and optionals inside the object.
 */
export function createUserNested(opts: {
  email: string;
  role: "admin" | "user";
  profile?: {
    displayName: string;
    tags: string[];
    age?: number;
  };
}): void {
  void opts;
}
