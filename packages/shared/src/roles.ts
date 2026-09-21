/** Built-in roles, ordered from most to least privileged. */
export const ROLES = ["owner", "admin", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Numeric rank; higher = more privileged. Used only for role comparison. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 40,
  admin: 30,
  editor: 20,
  commenter: 10,
  viewer: 0,
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
