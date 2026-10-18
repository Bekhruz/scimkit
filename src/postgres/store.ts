import { randomUUID } from 'node:crypto';
import { ScimError, VersionConflictError } from '../errors.js';
import type { JsonObject } from '../resource/json.js';
import type { Projection } from '../resource/projection.js';
import type { StoredResource } from '../resource/representation.js';
import type { ResourceTypeDefinition } from '../schema/resource-type.js';
import type {
  ListQuery,
  ListResult,
  ReadOptions,
  ScimContext,
  ScimRepository,
  ScimStore,
  WriteOptions,
} from '../store/repository.js';
import { isObject } from '../resource/json.js';
import { excludes } from '../resource/projection.js';
import { CompiledResourceType } from '../schema/resource-type.js';
import { uniqueAttributes, type UniqueAttribute } from '../store/uniqueness.js';
import {
  migrate,
  type PgPool,
  type PgQueryable,
  type PostgresTableOptions,
  sqlState,
  type TableNames,
  tableNames,
  transaction,
} from './schema.js';
import { compileFilter, compileSort, SqlBuilder } from './sql.js';

export interface PostgresScimStoreOptions extends PostgresTableOptions {
  /** A `pg.Pool` (node-postgres 8) or a pool with the same interface. */
  pool: PgPool;
  /**
   * What to do with group members that do not exist: `reject` (default)
   * answers 400, `ignore` drops them.
   */
  memberReferences?: 'reject' | 'ignore';
}

interface ResourceRow {
  id: string;
  resource_type: string;
  data: JsonObject;
  version: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'r.id, r.resource_type, r.data, r.version::text AS version, r.created_at, r.updated_at';

/**
 * Stores SCIM resources in PostgreSQL (13 or later): one table of resources
 * with their attributes as JSONB, one table of group memberships. Every row
 * belongs to a tenant. Run {@link PostgresScimStore.migrate} (or the SQL from
 * `migrationSql()`) before use.
 */
export class PostgresScimStore implements ScimStore {
  /** @internal */ readonly tables: TableNames;
  /** @internal */ readonly pool: PgPool;
  /** @internal */ readonly memberReferences: 'reject' | 'ignore';
  private readonly types = new Map<string, CompiledResourceType>();
  private readonly repositories = new Map<string, ScimRepository>();

  constructor(options: PostgresScimStoreOptions) {
    this.pool = options.pool;
    this.tables = tableNames(options);
    this.memberReferences = options.memberReferences ?? 'reject';
  }

  /** Creates or upgrades the tables. Safe to run on every start. */
  migrate(): Promise<number[]> {
    return migrate(this.pool, { schema: this.tables.schema, tablePrefix: this.tables.prefix });
  }

  repository(type: ResourceTypeDefinition): ScimRepository {
    const existing = this.repositories.get(type.name);
    if (existing !== undefined) return existing;
    const compiled = new CompiledResourceType(type);
    this.types.set(type.name, compiled);
    const repository = new PostgresRepository(this, compiled);
    this.repositories.set(type.name, repository);
    return repository;
  }

  /** @internal Names of the resource types that can be group members, by kind. */
  membershipTypes(): { users: string[]; groups: string[] } {
    const all = [...this.types.values()];
    return {
      users: all.filter((type) => type.isUser).map((type) => type.name),
      groups: all.filter((type) => type.isGroup).map((type) => type.name),
    };
  }
}

class PostgresRepository implements ScimRepository {
  private readonly tables: TableNames;
  private readonly unique: UniqueAttribute[];

  constructor(
    private readonly store: PostgresScimStore,
    private readonly type: CompiledResourceType,
  ) {
    this.tables = store.tables;
    // userName is enforced by a unique index; other unique attributes by a locked check.
    this.unique = uniqueAttributes(type).filter(
      (unique) => !(type.isUser && !unique.extension && unique.definition.name === 'userName'),
    );
  }

  async create(context: ScimContext, attributes: JsonObject): Promise<StoredResource> {
    return this.write(async (client) => {
      const id = randomUUID();
      const { data, members } = this.split(attributes);
      await this.assertUnique(client, context, id, data);
      await client.query(
        `INSERT INTO ${this.tables.resources} (tenant_id, id, resource_type, external_id, user_name, display_name, data)
VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [context.tenantId, id, this.type.name, ...this.columns(data), data],
      );
      if (members !== undefined) await this.writeMembers(client, context, id, members);
      return (await this.read(client, context, [id], {}))[0] as StoredResource;
    });
  }

  async get(
    context: ScimContext,
    id: string,
    options: ReadOptions = {},
  ): Promise<StoredResource | undefined> {
    return (await this.read(this.store.pool, context, [id], options.projection ?? {}))[0];
  }

  async list(context: ScimContext, query: ListQuery): Promise<ListResult> {
    const sql = new SqlBuilder(this.tables, this.type);
    const conditions = [
      `r.tenant_id = ${sql.param(context.tenantId)}`,
      `r.resource_type = ${sql.param(this.type.name)}`,
    ];
    if (query.filter !== undefined) conditions.push(compileFilter(query.filter, sql));
    const where = conditions.join(' AND ');
    const counted = await this.store.pool.query(
      `SELECT count(*)::int AS total FROM ${this.tables.resources} AS r WHERE ${where}`,
      sql.params,
    );
    const totalResults = (counted.rows[0] as { total: number }).total;
    if (totalResults === 0 || query.count === 0 || query.startIndex > totalResults) {
      return { totalResults, resources: [] };
    }
    const order =
      query.sortBy === undefined
        ? 'r.seq'
        : `${compileSort(query.sortBy, sql)} ${query.sortOrder === 'descending' ? 'DESC' : 'ASC'} NULLS LAST, r.seq`;
    const limit = sql.param(query.count);
    const offset = sql.param(query.startIndex - 1);
    const { rows } = await this.store.pool.query(
      `SELECT ${COLUMNS} FROM ${this.tables.resources} AS r WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      sql.params,
    );
    return {
      totalResults,
      resources: await this.attach(this.store.pool, context, rows as ResourceRow[], query.projection),
    };
  }

  async replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options: WriteOptions = {},
  ): Promise<StoredResource> {
    return this.write(async (client) => {
      await this.lockCurrent(client, context, id, options, true);
      const { data, members } = this.split(attributes);
      await this.assertUnique(client, context, id, data);
      await client.query(
        `UPDATE ${this.tables.resources}
SET external_id = $4, user_name = $5, display_name = $6, data = $7, version = version + 1, updated_at = clock_timestamp()
WHERE tenant_id = $1 AND resource_type = $2 AND id = $3`,
        [context.tenantId, this.type.name, id, ...this.columns(data), data],
      );
      if (this.type.isGroup) await this.writeMembers(client, context, id, members ?? []);
      return (await this.read(client, context, [id], {}))[0] as StoredResource;
    });
  }

  async delete(context: ScimContext, id: string, options: WriteOptions = {}): Promise<boolean> {
    return this.write(async (client) => {
      if (!(await this.lockCurrent(client, context, id, options, false))) return false;
      const { users } = this.store.membershipTypes();
      // Groups lose a member, and a deleted group's members lose a group: both change.
      await client.query(
        `UPDATE ${this.tables.resources} SET version = version + 1, updated_at = clock_timestamp()
WHERE tenant_id = $1 AND (
  id IN (SELECT group_id FROM ${this.tables.members} WHERE tenant_id = $1 AND member_id = $2)
  OR (resource_type = ANY($3::text[]) AND id IN (SELECT member_id FROM ${this.tables.members} WHERE tenant_id = $1 AND group_id = $2))
)`,
        [context.tenantId, id, users],
      );
      await client.query(`DELETE FROM ${this.tables.resources} WHERE tenant_id = $1 AND id = $2`, [
        context.tenantId,
        id,
      ]);
      return true;
    });
  }

  /** Runs a write in a transaction and maps constraint violations to SCIM errors. */
  private async write<T>(work: (client: PgQueryable) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.store.pool, work);
    } catch (error) {
      const state = sqlState(error);
      if (state === '23505') {
        throw ScimError.uniqueness(`A ${this.type.name} with this userName already exists.`);
      }
      if (state === '23503') throw ScimError.invalidValue('A group member does not exist.');
      throw error;
    }
  }

  /** Locks the current row and checks its version. Returns false when it does not exist (or throws 404). */
  private async lockCurrent(
    client: PgQueryable,
    context: ScimContext,
    id: string,
    options: WriteOptions,
    required: boolean,
  ): Promise<boolean> {
    const { rows } = await client.query(
      `SELECT version::text AS version FROM ${this.tables.resources} WHERE tenant_id = $1 AND resource_type = $2 AND id = $3 FOR UPDATE`,
      [context.tenantId, this.type.name, id],
    );
    const row = rows[0] as { version: string } | undefined;
    if (row === undefined) {
      if (required) throw ScimError.notFound(`${this.type.name} "${id}" was not found.`);
      return false;
    }
    if (options.expectedVersion !== undefined && options.expectedVersion !== row.version) {
      throw new VersionConflictError();
    }
    return true;
  }

  /** Group members live in their own table; everything else is JSONB. */
  private split(attributes: JsonObject): { data: JsonObject; members?: JsonObject[] } {
    if (!this.type.isGroup) return { data: attributes };
    const { members, ...data } = attributes;
    return { data, members: Array.isArray(members) ? members.filter(isObject) : [] };
  }

  /** external_id, user_name and display_name: copies of attributes for indexes and sorting. */
  private columns(data: JsonObject): [string | null, string | null, string | null] {
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    return [
      text(data['externalId']),
      this.type.isUser ? text(data['userName']) : null,
      text(data['displayName']),
    ];
  }

  private async assertUnique(
    client: PgQueryable,
    context: ScimContext,
    id: string,
    data: JsonObject,
  ): Promise<void> {
    for (const unique of this.unique) {
      const container = unique.extension ? data[unique.schema] : data;
      const value = isObject(container) ? container[unique.definition.name] : undefined;
      if (value === undefined || value === null) continue;
      const global = unique.definition.uniqueness === 'global';
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const key = unique.definition.caseExact || typeof value !== 'string' ? text : text.toLowerCase();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scimkit:unique:${this.tables.resources}:${global ? '*' : context.tenantId}:${this.type.name}:${unique.label}:${key}`,
      ]);
      const path = unique.extension
        ? `r.data -> '${unique.schema.replace(/'/g, "''")}' ->> '${unique.definition.name}'`
        : `r.data ->> '${unique.definition.name}'`;
      const compare =
        typeof value === 'string' && !unique.definition.caseExact
          ? `lower(${path}) = lower($3)`
          : `${path} = $3`;
      const scope = global ? 'NOT (r.tenant_id = $4 AND r.id = $2)' : 'r.tenant_id = $4 AND r.id <> $2';
      const { rows } = await client.query(
        `SELECT 1 FROM ${this.tables.resources} AS r WHERE r.resource_type = $1 AND ${scope} AND ${compare} LIMIT 1`,
        [this.type.name, id, text, context.tenantId],
      );
      if (rows.length > 0) {
        throw ScimError.uniqueness(`A ${this.type.name} with ${unique.label} "${text}" already exists.`);
      }
    }
  }

  /** Makes the group's member rows match `members`, keeping the order of existing members. */
  private async writeMembers(
    client: PgQueryable,
    context: ScimContext,
    groupId: string,
    members: JsonObject[],
  ): Promise<void> {
    const { users, groups } = this.store.membershipTypes();
    const wanted: { value: string; type?: string }[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      if (typeof member['value'] !== 'string' || seen.has(member['value'])) continue;
      if (member['value'] === groupId) throw ScimError.invalidValue('A group cannot be a member of itself.');
      seen.add(member['value']);
      wanted.push({
        value: member['value'],
        ...(typeof member['type'] === 'string' ? { type: member['type'] } : {}),
      });
    }
    const found = new Map<string, string>();
    if (wanted.length > 0) {
      const { rows } = await client.query(
        `SELECT id, resource_type FROM ${this.tables.resources} WHERE tenant_id = $1 AND id = ANY($2::text[]) AND resource_type = ANY($3::text[])`,
        [context.tenantId, wanted.map((member) => member.value), [...users, ...groups]],
      );
      for (const row of rows as { id: string; resource_type: string }[]) found.set(row.id, row.resource_type);
    }
    const desired: string[] = [];
    for (const member of wanted) {
      const actual = found.get(member.value);
      if (actual === undefined) {
        if (this.store.memberReferences === 'ignore') continue;
        throw ScimError.invalidValue(`Member "${member.value}" does not exist.`);
      }
      if (member.type !== undefined && member.type.toLowerCase() !== actual.toLowerCase()) {
        throw ScimError.invalidValue(`Member "${member.value}" is a ${actual}, not a ${member.type}.`);
      }
      desired.push(member.value);
    }
    const { rows: currentRows } = await client.query(
      `SELECT member_id FROM ${this.tables.members} WHERE tenant_id = $1 AND group_id = $2`,
      [context.tenantId, groupId],
    );
    const current = new Set((currentRows as { member_id: string }[]).map((row) => row.member_id));
    const wantedSet = new Set(desired);
    const removed = [...current].filter((id) => !wantedSet.has(id));
    const added = desired.filter((id) => !current.has(id));
    if (removed.length > 0) {
      await client.query(
        `DELETE FROM ${this.tables.members} WHERE tenant_id = $1 AND group_id = $2 AND member_id = ANY($3::text[])`,
        [context.tenantId, groupId, removed],
      );
    }
    if (added.length > 0) {
      await client.query(
        `INSERT INTO ${this.tables.members} (tenant_id, group_id, member_id)
SELECT $1, $2, member.id FROM unnest($3::text[]) WITH ORDINALITY AS member(id, position) ORDER BY member.position`,
        [context.tenantId, groupId, added],
      );
    }
    const changed = [...removed, ...added];
    if (changed.length > 0) {
      // A user's groups attribute is part of its representation, so its version changes too.
      await client.query(
        `UPDATE ${this.tables.resources} SET version = version + 1, updated_at = clock_timestamp()
WHERE tenant_id = $1 AND id = ANY($2::text[]) AND resource_type = ANY($3::text[])`,
        [context.tenantId, changed, users],
      );
    }
  }

  private async read(
    db: PgQueryable,
    context: ScimContext,
    ids: string[],
    projection: Projection,
  ): Promise<StoredResource[]> {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM ${this.tables.resources} AS r WHERE r.tenant_id = $1 AND r.resource_type = $2 AND r.id = ANY($3::text[])`,
      [context.tenantId, this.type.name, ids],
    );
    return this.attach(db, context, rows as ResourceRow[], projection);
  }

  /** Adds computed attributes: a group's members and a user's groups. */
  private async attach(
    db: PgQueryable,
    context: ScimContext,
    rows: ResourceRow[],
    projection: Projection,
  ): Promise<StoredResource[]> {
    const ids = rows.map((row) => row.id);
    const extra = new Map<string, JsonObject[]>();
    const add = (id: string, value: JsonObject) => {
      const list = extra.get(id) ?? [];
      list.push(value);
      extra.set(id, list);
    };
    if (ids.length > 0 && this.type.isGroup && !excludes(projection, this.type.coreUrn, 'members')) {
      const { rows: members } = await db.query(
        `SELECT m.group_id, m.member_id, mr.resource_type, coalesce(mr.display_name, mr.user_name) AS display
FROM ${this.tables.members} AS m JOIN ${this.tables.resources} AS mr ON mr.tenant_id = m.tenant_id AND mr.id = m.member_id
WHERE m.tenant_id = $1 AND m.group_id = ANY($2::text[]) ORDER BY m.seq`,
        [context.tenantId, ids],
      );
      for (const row of members as {
        group_id: string;
        member_id: string;
        resource_type: string;
        display: string | null;
      }[]) {
        add(row.group_id, {
          value: row.member_id,
          type: row.resource_type,
          ...(row.display === null ? {} : { display: row.display }),
        });
      }
    }
    if (ids.length > 0 && this.type.isUser && !excludes(projection, this.type.coreUrn, 'groups')) {
      const { rows: groups } = await db.query(
        `SELECT m.member_id, g.id, g.display_name
FROM ${this.tables.members} AS m JOIN ${this.tables.resources} AS g ON g.tenant_id = m.tenant_id AND g.id = m.group_id
WHERE m.tenant_id = $1 AND m.member_id = ANY($2::text[]) ORDER BY g.seq`,
        [context.tenantId, ids],
      );
      for (const row of groups as { member_id: string; id: string; display_name: string | null }[]) {
        add(row.member_id, {
          value: row.id,
          ...(row.display_name === null ? {} : { display: row.display_name }),
          type: 'direct',
        });
      }
    }
    const key = this.type.isGroup ? 'members' : 'groups';
    return rows.map((row) => {
      const attributes: JsonObject = { ...row.data };
      const computed = extra.get(row.id);
      if (computed !== undefined && (this.type.isGroup || this.type.isUser)) attributes[key] = computed;
      return {
        id: row.id,
        version: row.version,
        created: row.created_at,
        lastModified: row.updated_at,
        attributes,
      };
    });
  }
}
