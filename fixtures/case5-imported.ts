import { UserProfile, Role } from "./shared-types";

/**
 * Updates a user profile (type imported from a sibling file that exists on disk).
 * @param profile - The profile to update
 * @param role - The role to assign
 */
export function updateProfile(profile: UserProfile, role: Role): boolean {
  return profile.id.length > 0 && role.length > 0;
}
