import { randomUUID } from 'node:crypto';
import { isVersionConflict, ScimError, VersionConflictError } from '../errors.js';
import { compareSortValues, evaluateFilter, sortValue } from '../filter/evaluate.js';
import { targetDefinition } from '../filter/ast.js';
import { cloneJson, isObject, type JsonObject } from '../resource/json.js';
import { excludes, type Projection } from '../resource/projection.js';
import type { StoredResource } from '../resource/representation.js';
import { CompiledResourceType, type ResourceTypeDefinition } from '../schema/resource-type.js';
import { uniqueAttributes, uniqueValue } from './uniqueness.js';
import type {
  ListQuery,
  ListResult,
  ReadOptions,
  ScimContext,
  ScimRepository,
  ScimStore,
  WriteOptions,
} from './repository.js';

export interface MemoryScimStoreOptions {
  /**
   * What to do with group members that do not exist: `reject` (default)
   * answers 400, `ignore` drops them.
   */
  memberReferences?: 'reject' | 'ignore';
  now?: () => Date;
  generateId?: () => string;
}

interface Entry {
  id: string;
  version: number;
  created: Date;
  lastModified: Date;
  sequence: number;
  attributes: JsonObject;
}

/**
 * Keeps resources in memory, scoped by tenant. Behaves like the PostgreSQL
 * store (filtering, sorting, uniqueness, group membership, versions), so it
 * suits tests, examples and prototypes. Data is lost when the process exits.
 */
export class MemoryScimStore implements ScimStore {
  private readonly tenants = new Map<string, Map<string, Map<string, Entry>>>();
  private readonly types = new Map<string, CompiledResourceType>();
  private readonly repositories = new Map<string, ScimRepository>();
  private sequence = 0;
  readonly now: () => Date;
  readonly generateId: () => string;
  readonly memberReferences: 'reject' | 'ignore';

  constructor(options: MemoryScimStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.memberReferences = options.memberReferences ?? 'reject';
  }

  repository(type: ResourceTypeDefinition): ScimRepository {
    const existing = this.repositories.get(type.name);
    if (existing !== undefined) return existing;
    const compiled = new CompiledResourceType(type);
    this.types.set(type.name, compiled);
    const repository = new MemoryRepository(this, compiled);
    this.repositories.set(type.name, repository);
    return repository;
  }

  /** Removes every resource of every tenant. */
  clear(): void {
    this.tenants.clear();
  }

  /** @internal */
  entries(tenantId: string, typeName: string): Map<string, Entry> {
    let tenant = this.tenants.get(tenantId);
    if (tenant === undefined) {
      tenant = new Map();
      this.tenants.set(tenantId, tenant);
    }
    let entries = tenant.get(typeName);
    if (entries === undefined) {
      entries = new Map();
      tenant.set(typeName, entries);
    }
    return entries;
  }

  /** @internal */
  allTenants(): Iterable<string> {
    return this.tenants.keys();
  }

  /** @internal */
  nextSequence(): number {
    this.sequence++;
    return this.sequence;
  }

  /** @internal Resource types that take part in group membership. */
  membershipTypes(): { users: CompiledResourceType[]; groups: CompiledResourceType[] } {
    const all = [...this.types.values()];
    return { users: all.filter((type) => type.isUser), groups: all.filter((type) => type.isGroup) };
  }

  /** @internal Finds the type of a resource that can be a group member. */
  memberType(tenantId: string, id: string): CompiledResourceType | undefined {
    const { users, groups } = this.membershipTypes();
    return [...users, ...groups].find((type) => this.entries(tenantId, type.name).has(id));
  }

  /** @internal Bumps the version of resources whose computed attributes changed. */
  touch(tenantId: string, ids: Iterable<string>, at: Date): void {
    const { users } = this.membershipTypes();
    for (const id of ids) {
      for (const type of users) {
        const entry = this.entries(tenantId, type.name).get(id);
        if (entry !== undefined) {
          entry.version++;
          entry.lastModified = at;
        }
      }
    }
  }
}

class MemoryRepository implements ScimRepository {
  constructor(
    private readonly store: MemoryScimStore,
    private readonly type: CompiledResourceType,
  ) {}

  create(context: ScimContext, attributes: JsonObject): Promise<StoredResource> {
    return attempt(() => {
      const entries = this.store.entries(context.tenantId, this.type.name);
      const id = this.store.generateId();
      if (entries.has(id)) throw new Error(`Generated id ${id} already exists.`);
      const data = this.prepare(context, id, cloneJson(attributes));
      this.assertUnique(context, id, data);
      const now = this.store.now();
      const entry: Entry = {
        id,
        version: 1,
        created: now,
        lastModified: now,
        sequence: this.store.nextSequence(),
        attributes: data,
      };
      entries.set(id, entry);
      if (this.type.isGroup) this.store.touch(context.tenantId, memberIds(data), now);
      return this.toStored(context, entry, {});
    });
  }

  get(context: ScimContext, id: string, options: ReadOptions = {}): Promise<StoredResource | undefined> {
    const entry = this.store.entries(context.tenantId, this.type.name).get(id);
    return Promise.resolve(
      entry === undefined ? undefined : this.toStored(context, entry, options.projection ?? {}),
    );
  }

  list(context: ScimContext, query: ListQuery): Promise<ListResult> {
    const entries = [...this.store.entries(context.tenantId, this.type.name).values()];
    const documents = entries.map((entry) => ({ entry, stored: this.toStored(context, entry, {}) }));
    const matching = documents.filter(
      ({ entry, stored }) =>
        query.filter === undefined || evaluateFilter(query.filter, this.document(entry, stored)),
    );
    const sortBy = query.sortBy;
    matching.sort((left, right) => {
      if (sortBy !== undefined) {
        const a = sortValue(this.document(left.entry, left.stored), sortBy);
        const b = sortValue(this.document(right.entry, right.stored), sortBy);
        if (a === undefined || b === undefined) {
          if (a !== b) return a === undefined ? 1 : -1;
        } else {
          const order = compareSortValues(a, b, targetDefinition(sortBy));
          if (order !== 0) return query.sortOrder === 'descending' ? -order : order;
        }
      }
      return left.entry.sequence - right.entry.sequence;
    });
    const page = matching.slice(query.startIndex - 1, query.startIndex - 1 + query.count);
    return Promise.resolve({
      totalResults: matching.length,
      resources: page.map(({ entry }) => this.toStored(context, entry, query.projection)),
    });
  }

  replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options: WriteOptions = {},
  ): Promise<StoredResource> {
    return attempt(() => {
      const entry = this.store.entries(context.tenantId, this.type.name).get(id);
      if (entry === undefined) throw ScimError.notFound(`${this.type.name} "${id}" was not found.`);
      if (options.expectedVersion !== undefined && options.expectedVersion !== String(entry.version)) {
        throw new VersionConflictError();
      }
      const data = this.prepare(context, id, cloneJson(attributes));
      this.assertUnique(context, id, data);
      if (this.type.isGroup && Array.isArray(data['members'])) {
        // Members keep the order they joined in; new members go last (as in PostgreSQL).
        const before = memberIds(entry.attributes);
        const position = (member: unknown) => {
          const index = before.indexOf(String((member as JsonObject)['value']));
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        data['members'] = [...(data['members'] as unknown[])].sort((a, b) => position(a) - position(b));
      }
      const now = this.store.now();
      const changedMembers = this.type.isGroup
        ? symmetricDifference(memberIds(entry.attributes), memberIds(data))
        : [];
      entry.attributes = data;
      entry.version++;
      entry.lastModified = now;
      this.store.touch(context.tenantId, changedMembers, now);
      return this.toStored(context, entry, {});
    });
  }

  delete(context: ScimContext, id: string, options: WriteOptions = {}): Promise<boolean> {
    return attempt(() => {
      const entries = this.store.entries(context.tenantId, this.type.name);
      const entry = entries.get(id);
      if (entry === undefined) return false;
      if (options.expectedVersion !== undefined && options.expectedVersion !== String(entry.version)) {
        throw new VersionConflictError();
      }
      entries.delete(id);
      const now = this.store.now();
      if (this.type.isGroup) this.store.touch(context.tenantId, memberIds(entry.attributes), now);
      // A deleted resource leaves every group it was a member of.
      for (const groupType of this.store.membershipTypes().groups) {
        for (const group of this.store.entries(context.tenantId, groupType.name).values()) {
          const members = group.attributes['members'];
          if (
            !Array.isArray(members) ||
            !members.some((member) => isObject(member) && member['value'] === id)
          ) {
            continue;
          }
          const remaining = members.filter((member) => !(isObject(member) && member['value'] === id));
          if (remaining.length === 0) delete group.attributes['members'];
          else group.attributes['members'] = remaining;
          group.version++;
          group.lastModified = now;
        }
      }
      return true;
    });
  }

  /** Validates group members: they must exist; their type is recorded. */
  private prepare(context: ScimContext, id: string, data: JsonObject): JsonObject {
    if (!this.type.isGroup || !Array.isArray(data['members'])) return data;
    const seen = new Set<string>();
    const members: JsonObject[] = [];
    for (const member of data['members']) {
      if (!isObject(member) || typeof member['value'] !== 'string') continue;
      const value = member['value'];
      if (seen.has(value)) continue;
      if (value === id) throw ScimError.invalidValue('A group cannot be a member of itself.');
      const memberType = this.store.memberType(context.tenantId, value);
      if (memberType === undefined) {
        if (this.store.memberReferences === 'ignore') continue;
        throw ScimError.invalidValue(`Member "${value}" does not exist.`);
      }
      if (
        typeof member['type'] === 'string' &&
        member['type'].toLowerCase() !== memberType.name.toLowerCase()
      ) {
        throw ScimError.invalidValue(`Member "${value}" is a ${memberType.name}, not a ${member['type']}.`);
      }
      seen.add(value);
      members.push({ value, type: memberType.name });
    }
    if (members.length === 0) delete data['members'];
    else data['members'] = members;
    return data;
  }

  private assertUnique(context: ScimContext, id: string, data: JsonObject): void {
    for (const unique of uniqueAttributes(this.type)) {
      const value = uniqueValue(data, unique);
      if (value === undefined) continue;
      const tenants =
        unique.definition.uniqueness === 'global' ? [...this.store.allTenants()] : [context.tenantId];
      for (const tenantId of tenants) {
        for (const other of this.store.entries(tenantId, this.type.name).values()) {
          if (other.id === id && tenantId === context.tenantId) continue;
          if (uniqueValue(other.attributes, unique) === value) {
            throw ScimError.uniqueness(
              `A ${this.type.name} with ${unique.label} "${String(value)}" already exists.`,
            );
          }
        }
      }
    }
  }

  /** The representation filters run against: attributes plus id and meta. */
  private document(entry: Entry, stored: StoredResource): JsonObject {
    return {
      ...stored.attributes,
      id: entry.id,
      meta: {
        resourceType: this.type.name,
        created: entry.created.toISOString(),
        lastModified: entry.lastModified.toISOString(),
      },
    };
  }

  private toStored(context: ScimContext, entry: Entry, projection: Projection): StoredResource {
    const attributes = cloneJson(entry.attributes);
    if (this.type.isGroup && Array.isArray(attributes['members'])) {
      if (excludes(projection, this.type.coreUrn, 'members')) {
        delete attributes['members'];
      } else {
        attributes['members'] = (attributes['members'] as JsonObject[]).map((member) => {
          const display = this.displayOf(context, String(member['value']));
          return display === undefined ? member : { ...member, display };
        });
      }
    }
    if (this.type.isUser && !excludes(projection, this.type.coreUrn, 'groups')) {
      const groups = this.groupsOf(context, entry.id);
      if (groups.length > 0) attributes['groups'] = groups;
    }
    return {
      id: entry.id,
      version: String(entry.version),
      created: entry.created,
      lastModified: entry.lastModified,
      attributes,
    };
  }

  private displayOf(context: ScimContext, id: string): string | undefined {
    const type = this.store.memberType(context.tenantId, id);
    const entry = type === undefined ? undefined : this.store.entries(context.tenantId, type.name).get(id);
    if (entry === undefined) return undefined;
    const display = entry.attributes['displayName'] ?? entry.attributes['userName'];
    return typeof display === 'string' ? display : undefined;
  }

  private groupsOf(context: ScimContext, userId: string): JsonObject[] {
    const groups: { sequence: number; value: JsonObject }[] = [];
    for (const groupType of this.store.membershipTypes().groups) {
      for (const group of this.store.entries(context.tenantId, groupType.name).values()) {
        if (!memberIds(group.attributes).includes(userId)) continue;
        const display = group.attributes['displayName'];
        groups.push({
          sequence: group.sequence,
          value: { value: group.id, ...(typeof display === 'string' ? { display } : {}), type: 'direct' },
        });
      }
    }
    return groups.sort((a, b) => a.sequence - b.sequence).map((group) => group.value);
  }
}

function memberIds(attributes: JsonObject): string[] {
  const members = attributes['members'];
  if (!Array.isArray(members)) return [];
  return members.flatMap((member) =>
    isObject(member) && typeof member['value'] === 'string' ? [member['value']] : [],
  );
}

function symmetricDifference(left: readonly string[], right: readonly string[]): string[] {
  const a = new Set(left);
  const b = new Set(right);
  return [...left.filter((id) => !b.has(id)), ...right.filter((id) => !a.has(id))];
}

/** Runs a synchronous store operation and turns its outcome into a promise. */
function attempt<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(
      isVersionConflict(error) || error instanceof Error ? error : new Error(String(error)),
    );
  }
}
