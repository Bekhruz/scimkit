import { randomUUID } from 'node:crypto';
import {
  type JsonObject,
  type ListQuery,
  type ListResult,
  type ScimContext,
  ScimError,
  type ScimRepository,
  type SimpleEquality,
  simpleEquality,
  type StoredResource,
  VersionConflictError,
  type WriteOptions,
} from 'scimkit';
import type { AppDatabase, TeamRow, UserRow } from './app-database.js';

/**
 * Provisions SCIM Users into the application's own users table.
 *
 * The columns the application owns (username, names, active flag, email)
 * are the source of truth for those attributes; every other SCIM attribute
 * round-trips through the `scimAttributes` JSON column, so nothing a client
 * sends is lost. The SCIM organization (tenant) is `context.tenantId`.
 */
export class UsersRepository implements ScimRepository {
  constructor(private readonly db: AppDatabase) {}

  create(context: ScimContext, attributes: JsonObject): Promise<StoredResource> {
    const now = new Date();
    const row: UserRow = {
      id: randomUUID(),
      organizationId: context.tenantId,
      ...this.columns(attributes),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.assertUniqueUsername(row);
    this.db.users.set(row.id, row);
    return Promise.resolve(this.toScim(row));
  }

  get(context: ScimContext, id: string): Promise<StoredResource | undefined> {
    const row = this.find(context, id);
    return Promise.resolve(row === undefined ? undefined : this.toScim(row));
  }

  list(context: ScimContext, query: ListQuery): Promise<ListResult> {
    // Each condition becomes part of a WHERE clause in a real database.
    const predicates = supportedConditions(query).map((condition): ((row: UserRow) => boolean) => {
      const text = String(condition.value).toLowerCase();
      switch (condition.attribute) {
        case 'id':
          return (row) => row.id === condition.value;
        case 'userName':
          return (row) => row.username.toLowerCase() === text;
        case 'externalId':
          return (row) => row.scimExternalId === condition.value;
        case 'emails.value':
          return (row) => row.email?.toLowerCase() === text;
        case 'active':
          return (row) => row.isActive === condition.value;
        default:
          throw ScimError.invalidFilter(`Filtering users by ${condition.attribute} is not supported.`);
      }
    });
    const rows = this.db
      .usersOf(context.tenantId)
      .filter((row) => predicates.every((matches) => matches(row)));
    return Promise.resolve(page(rows, query, (row) => this.toScim(row)));
  }

  replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options: WriteOptions = {},
  ): Promise<StoredResource> {
    const row = this.find(context, id);
    if (row === undefined) return Promise.reject(ScimError.notFound(`User "${id}" was not found.`));
    if (options.expectedVersion !== undefined && options.expectedVersion !== String(row.version)) {
      return Promise.reject(new VersionConflictError());
    }
    const updated: UserRow = {
      ...row,
      ...this.columns(attributes),
      version: row.version + 1,
      updatedAt: new Date(),
    };
    try {
      this.assertUniqueUsername(updated);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.db.users.set(id, updated);
    return Promise.resolve(this.toScim(updated));
  }

  delete(context: ScimContext, id: string, options: WriteOptions = {}): Promise<boolean> {
    const row = this.find(context, id);
    if (row === undefined) return Promise.resolve(false);
    if (options.expectedVersion !== undefined && options.expectedVersion !== String(row.version)) {
      return Promise.reject(new VersionConflictError());
    }
    this.db.users.delete(id);
    for (const team of this.db.teamsOf(context.tenantId)) {
      if (!team.memberIds.includes(id)) continue;
      team.memberIds = team.memberIds.filter((memberId) => memberId !== id);
      team.version++;
      team.updatedAt = new Date();
    }
    return Promise.resolve(true);
  }

  private find(context: ScimContext, id: string): UserRow | undefined {
    const row = this.db.users.get(id);
    return row?.organizationId === context.tenantId ? row : undefined;
  }

  private assertUniqueUsername(row: UserRow): void {
    const taken = this.db
      .usersOf(row.organizationId)
      .some((other) => other.id !== row.id && other.username.toLowerCase() === row.username.toLowerCase());
    if (taken) throw ScimError.uniqueness(`The username "${row.username}" is taken.`);
  }

  /** SCIM attributes → columns. */
  private columns(
    attributes: JsonObject,
  ): Omit<UserRow, 'id' | 'organizationId' | 'version' | 'createdAt' | 'updatedAt'> {
    const { userName, externalId, name, displayName, active, groups: _groups, ...rest } = attributes;
    const names = (name ?? {}) as { givenName?: string; familyName?: string };
    const emails = (attributes['emails'] ?? []) as { value?: string; type?: string; primary?: boolean }[];
    const email =
      emails.find((entry) => entry.primary === true) ??
      emails.find((entry) => entry.type === 'work') ??
      emails[0];
    const { givenName: _given, familyName: _family, ...otherNames } = names;
    return {
      username: String(userName),
      email: email?.value ?? null,
      firstName: names.givenName ?? null,
      lastName: names.familyName ?? null,
      displayName: typeof displayName === 'string' ? displayName : null,
      isActive: active !== false,
      scimExternalId: typeof externalId === 'string' ? externalId : null,
      scimAttributes: Object.keys(otherNames).length > 0 ? { ...rest, name: otherNames } : rest,
    };
  }

  /** Columns → SCIM attributes; the application's columns win. */
  private toScim(row: UserRow): StoredResource {
    const name = {
      ...((row.scimAttributes['name'] as JsonObject | undefined) ?? {}),
      ...(row.firstName === null ? {} : { givenName: row.firstName }),
      ...(row.lastName === null ? {} : { familyName: row.lastName }),
    };
    const groups = this.db
      .teamsOf(row.organizationId)
      .filter((team) => team.memberIds.includes(row.id))
      .map((team) => ({ value: team.id, display: team.name, type: 'direct' }));
    return {
      id: row.id,
      version: String(row.version),
      created: row.createdAt,
      lastModified: row.updatedAt,
      attributes: {
        ...row.scimAttributes,
        userName: row.username,
        ...(row.scimExternalId === null ? {} : { externalId: row.scimExternalId }),
        ...(Object.keys(name).length === 0 ? {} : { name }),
        ...(row.displayName === null ? {} : { displayName: row.displayName }),
        active: row.isActive,
        ...(groups.length === 0 ? {} : { groups }),
      },
    };
  }
}

/** Provisions SCIM Groups into the application's teams table. */
export class TeamsRepository implements ScimRepository {
  constructor(private readonly db: AppDatabase) {}

  create(context: ScimContext, attributes: JsonObject): Promise<StoredResource> {
    const now = new Date();
    const row: TeamRow = {
      id: randomUUID(),
      organizationId: context.tenantId,
      name: String(attributes['displayName']),
      memberIds: [],
      scimExternalId: typeof attributes['externalId'] === 'string' ? attributes['externalId'] : null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      row.memberIds = this.memberIds(context, row.id, attributes);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.db.teams.set(row.id, row);
    this.touchUsers(row.memberIds);
    return Promise.resolve(this.toScim(row));
  }

  get(context: ScimContext, id: string): Promise<StoredResource | undefined> {
    const row = this.find(context, id);
    return Promise.resolve(row === undefined ? undefined : this.toScim(row));
  }

  list(context: ScimContext, query: ListQuery): Promise<ListResult> {
    const predicates = supportedConditions(query).map((condition): ((row: TeamRow) => boolean) => {
      switch (condition.attribute) {
        case 'id':
          return (row) => row.id === condition.value;
        case 'displayName':
          return (row) => row.name.toLowerCase() === String(condition.value).toLowerCase();
        case 'externalId':
          return (row) => row.scimExternalId === condition.value;
        case 'members.value':
          return (row) => row.memberIds.includes(String(condition.value));
        default:
          throw ScimError.invalidFilter(`Filtering groups by ${condition.attribute} is not supported.`);
      }
    });
    const rows = this.db
      .teamsOf(context.tenantId)
      .filter((row) => predicates.every((matches) => matches(row)));
    return Promise.resolve(page(rows, query, (row) => this.toScim(row)));
  }

  replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options: WriteOptions = {},
  ): Promise<StoredResource> {
    const row = this.find(context, id);
    if (row === undefined) return Promise.reject(ScimError.notFound(`Group "${id}" was not found.`));
    if (options.expectedVersion !== undefined && options.expectedVersion !== String(row.version)) {
      return Promise.reject(new VersionConflictError());
    }
    let memberIds: string[];
    try {
      memberIds = this.memberIds(context, id, attributes);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const changed = [
      ...row.memberIds.filter((memberId) => !memberIds.includes(memberId)),
      ...memberIds.filter((memberId) => !row.memberIds.includes(memberId)),
    ];
    const updated: TeamRow = {
      ...row,
      name: String(attributes['displayName']),
      memberIds,
      scimExternalId: typeof attributes['externalId'] === 'string' ? attributes['externalId'] : null,
      version: row.version + 1,
      updatedAt: new Date(),
    };
    this.db.teams.set(id, updated);
    this.touchUsers(changed);
    return Promise.resolve(this.toScim(updated));
  }

  delete(context: ScimContext, id: string, options: WriteOptions = {}): Promise<boolean> {
    const row = this.find(context, id);
    if (row === undefined) return Promise.resolve(false);
    if (options.expectedVersion !== undefined && options.expectedVersion !== String(row.version)) {
      return Promise.reject(new VersionConflictError());
    }
    this.db.teams.delete(id);
    this.touchUsers(row.memberIds);
    return Promise.resolve(true);
  }

  private find(context: ScimContext, id: string): TeamRow | undefined {
    const row = this.db.teams.get(id);
    return row?.organizationId === context.tenantId ? row : undefined;
  }

  /** Teams hold users only; every member must be a user of the same organization. */
  private memberIds(context: ScimContext, teamId: string, attributes: JsonObject): string[] {
    const members = (attributes['members'] ?? []) as { value: string; type?: string }[];
    const ids: string[] = [];
    for (const member of members) {
      if (ids.includes(member.value)) continue;
      const user = this.db.users.get(member.value);
      if (
        member.value === teamId ||
        user?.organizationId !== context.tenantId ||
        (member.type ?? 'User') !== 'User'
      ) {
        throw ScimError.invalidValue(`Member "${member.value}" is not a user of this organization.`);
      }
      ids.push(member.value);
    }
    return ids;
  }

  /** A user's `groups` attribute changes with team membership, and so does its version. */
  private touchUsers(ids: readonly string[]): void {
    for (const id of ids) {
      const user = this.db.users.get(id);
      if (user === undefined) continue;
      user.version++;
      user.updatedAt = new Date();
    }
  }

  private toScim(row: TeamRow): StoredResource {
    const members = row.memberIds.map((id) => {
      const user = this.db.users.get(id);
      return {
        value: id,
        type: 'User',
        ...(user === undefined ? {} : { display: user.displayName ?? user.username }),
      };
    });
    return {
      id: row.id,
      version: String(row.version),
      created: row.createdAt,
      lastModified: row.updatedAt,
      attributes: {
        displayName: row.name,
        ...(row.scimExternalId === null ? {} : { externalId: row.scimExternalId }),
        ...(members.length === 0 ? {} : { members }),
      },
    };
  }
}

/** The filters this application answers: eq conditions joined with and, which is what IdPs send. */
function supportedConditions(query: ListQuery): SimpleEquality[] {
  const conditions = simpleEquality(query.filter);
  if (conditions === undefined) {
    throw ScimError.invalidFilter(
      'This service provider supports filters of eq comparisons joined with and.',
    );
  }
  return conditions;
}

function page<T>(rows: readonly T[], query: ListQuery, map: (row: T) => StoredResource): ListResult {
  return {
    totalResults: rows.length,
    resources: rows.slice(query.startIndex - 1, query.startIndex - 1 + query.count).map(map),
  };
}
