export interface UserProfile {
  id: string;
  displayName: string;
  tags: string[];
  address?: {
    city: string;
    zip: string;
  };
}

export type Role = "admin" | "editor" | "viewer";
