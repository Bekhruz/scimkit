/**
 * Stand-in for your application's own database: a users table and a teams
 * table with their own column names. In a real application these are your
 * Prisma, TypeORM, Drizzle or SQL tables.
 */
export interface UserRow {
  id: string;
  organizationId: string;
  /** The login name; SCIM `userName`. Unique per organization, case-insensitively. */
  username: string;
  /** The work email the app sends mail to, taken from SCIM `emails`. */
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  isActive: boolean;
  scimExternalId: string | null;
  /** SCIM attributes the app has no columns for (phone numbers, addresses, ...), as JSON. */
  scimAttributes: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamRow {
  id: string;
  organizationId: string;
  name: string;
  memberIds: string[];
  scimExternalId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class AppDatabase {
  readonly users = new Map<string, UserRow>();
  readonly teams = new Map<string, TeamRow>();

  usersOf(organizationId: string): UserRow[] {
    return [...this.users.values()].filter((user) => user.organizationId === organizationId);
  }

  teamsOf(organizationId: string): TeamRow[] {
    return [...this.teams.values()].filter((team) => team.organizationId === organizationId);
  }
}
