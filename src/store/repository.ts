import type { ResolvedFilter, ResolvedPath } from '../filter/ast.js';
import type { JsonObject } from '../resource/json.js';
import type { Projection } from '../resource/projection.js';
import type { StoredResource } from '../resource/representation.js';
import type { ResourceTypeDefinition } from '../schema/resource-type.js';

/** Who is calling: the result of `authenticate`. */
export interface ScimPrincipal {
  /** The tenant (your customer) the provisioning client acts for. Every repository call is scoped to it. */
  readonly tenantId: string;
  /** An identifier of the credential, for logs and audit, such as a token id. */
  readonly subject?: string;
  readonly [key: string]: unknown;
}

/** Passed to repositories and hooks for every operation. */
export interface ScimContext {
  readonly tenantId: string;
  readonly principal: ScimPrincipal;
  readonly requestId: string;
  /** Absolute URL of the SCIM root, without a trailing slash. */
  readonly baseUrl: string;
  readonly signal?: AbortSignal;
}

export type SortOrder = 'ascending' | 'descending';

/** A list or search request, validated and resolved against the resource type. */
export interface ListQuery {
  readonly filter?: ResolvedFilter;
  /** 1-based index of the first result. */
  readonly startIndex: number;
  /** Maximum number of resources to return; 0 asks for `totalResults` only. */
  readonly count: number;
  readonly sortBy?: ResolvedPath;
  readonly sortOrder: SortOrder;
  /** The attributes the client asked for: a hint that lets a repository skip loading data. */
  readonly projection: Projection;
}

export interface ListResult {
  readonly totalResults: number;
  readonly resources: readonly StoredResource[];
}

export interface ReadOptions {
  /** The attributes the client asked for: a hint that lets a repository skip loading data. */
  readonly projection?: Projection;
}

export interface WriteOptions {
  /**
   * The version the write is based on. When it is no longer current the
   * repository throws {@link VersionConflictError}.
   */
  readonly expectedVersion?: string;
}

/**
 * Storage for one resource type. Implement it to provision into your own
 * tables, or use a built-in store (`MemoryScimStore`, `PostgresScimStore`).
 *
 * Attributes arrive validated and in canonical form. Repositories enforce
 * `uniqueness: "server"` attributes (throw `ScimError.uniqueness`), generate
 * ids, keep versions and timestamps, and are responsible for tenant isolation:
 * every call carries `context.tenantId`.
 */
export interface ScimRepository {
  create(context: ScimContext, attributes: JsonObject): Promise<StoredResource>;
  get(context: ScimContext, id: string, options?: ReadOptions): Promise<StoredResource | undefined>;
  list(context: ScimContext, query: ListQuery): Promise<ListResult>;
  /** Replaces all attributes. Throws `ScimError.notFound` when the resource does not exist. */
  replace(
    context: ScimContext,
    id: string,
    attributes: JsonObject,
    options?: WriteOptions,
  ): Promise<StoredResource>;
  /** Returns false when the resource does not exist. */
  delete(context: ScimContext, id: string, options?: WriteOptions): Promise<boolean>;
}

/** A store serves repositories for any number of resource types. */
export interface ScimStore {
  repository(type: ResourceTypeDefinition): ScimRepository;
}
