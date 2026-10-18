import { randomUUID } from 'node:crypto';
import { SCIM_CONTENT_TYPE, SCIM_MESSAGES } from '../constants.js';
import { isScimError, isVersionConflict, ScimError } from '../errors.js';
import { parseFilter } from '../filter/parser.js';
import { resolveFilter } from '../filter/resolve.js';
import { applyPatch, parsePatchBody } from '../patch/apply.js';
import { deepEqual, isObject, type JsonObject } from '../resource/json.js';
import {
  normalizeAttributes,
  normalizeResourceBody,
  type NormalizedAttributes,
} from '../resource/normalize.js';
import { projectResource, type Projection } from '../resource/projection.js';
import {
  etagOf,
  locationOf,
  type ReferenceResolver,
  type ScimResource,
  type StoredResource,
  toScimResource,
} from '../resource/representation.js';
import type { SchemaDefinition } from '../schema/definitions.js';
import {
  CompiledResourceType,
  GroupResourceType,
  type ResourceTypeDefinition,
  UserResourceType,
} from '../schema/resource-type.js';
import type {
  ListQuery,
  ScimContext,
  ScimPrincipal,
  ScimRepository,
  ScimStore,
} from '../store/repository.js';
import { type BulkOperation, bulkReferences, parseBulkRequest, substituteReferences } from './bulk.js';
import {
  type AuthenticationScheme,
  BEARER_TOKEN_SCHEME,
  resourceTypeResource,
  schemaResource,
  serviceProviderConfig,
} from './discovery.js';
import { bodySize, consoleLogger, etagMatches, header, parseJsonBody, QueryParameters } from './http.js';
import {
  parseListQuery,
  parsePagination,
  parseProjection,
  type QueryLimits,
  type RawListParameters,
} from './query.js';
import type {
  Authenticator,
  BeforeWriteEvent,
  MemberReference,
  ScimEvent,
  ScimHooks,
  ScimHttpRequest,
  ScimHttpResponse,
  ScimLogger,
} from './types.js';

export interface ScimLimits {
  /** Most resources returned by one list request (`filter.maxResults`). Default 200. */
  maxResults: number;
  /** Page size when the client sends no `count`. Default 100. */
  defaultCount: number;
  /** Most operations in one PATCH request. Default 1000. */
  maxPatchOperations: number;
  /** Most operations in one bulk request. Default 1000. */
  maxBulkOperations: number;
  /** Largest bulk request body in bytes. Default 1 MiB. */
  maxBulkPayloadBytes: number;
  /** Longest filter in characters. Default 4096. */
  maxFilterLength: number;
  /** Deepest filter nesting. Default 32. */
  maxFilterDepth: number;
  /** Most comparisons in one filter. Default 128. */
  maxFilterComparisons: number;
}

/** Which resource a `/Me` request refers to. */
export interface MeTarget {
  readonly resourceType: string;
  readonly id: string;
}

export interface ScimServerOptions {
  /** Defaults to the User (with the Enterprise extension) and Group resource types. */
  resourceTypes?: readonly ResourceTypeDefinition[];
  /** Serves every resource type that has no entry in `repositories`. */
  store?: ScimStore;
  /** Repositories by resource type name, for types you store yourself. */
  repositories?: Readonly<Record<string, ScimRepository>>;
  /** Verifies the credentials of every request; see `bearerTokenAuth` and `staticTokenAuth`. */
  authenticate: Authenticator;
  /**
   * Absolute URL of the SCIM root, such as `https://api.example.com/scim/v2`.
   * Used for `meta.location`, `Location` and `$ref`. When omitted, adapters derive it from the request.
   */
  baseUrl?: string;
  /**
   * `lenient` (default) accepts what real provisioning clients send even where
   * it departs from RFC 7643/7644; `strict` rejects it. See the README.
   */
  compatibility?: 'lenient' | 'strict';
  limits?: Partial<ScimLimits>;
  /** Serve `/Bulk`. Default true. */
  bulk?: boolean;
  /** Require authentication for /ServiceProviderConfig, /ResourceTypes and /Schemas. Default true. */
  discoveryRequiresAuthentication?: boolean;
  documentationUri?: string;
  /** Advertised in /ServiceProviderConfig. Defaults to an OAuth bearer token scheme. */
  authenticationSchemes?: readonly AuthenticationScheme[];
  hooks?: ScimHooks;
  /** Defaults to a logger that prints warnings and errors to the console. */
  logger?: ScimLogger;
  /** Resolves `/Me` to a resource. Without it, `/Me` answers 501. */
  me?: (context: ScimContext) => MeTarget | undefined | Promise<MeTarget | undefined>;
}

const DEFAULT_LIMITS: ScimLimits = {
  maxResults: 200,
  defaultCount: 100,
  maxPatchOperations: 1000,
  maxBulkOperations: 1000,
  maxBulkPayloadBytes: 1_048_576,
  maxFilterLength: 4096,
  maxFilterDepth: 32,
  maxFilterComparisons: 128,
};

const MAX_WRITE_ATTEMPTS = 8;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface OperationInput {
  readonly context: ScimContext;
  readonly type: CompiledResourceType;
  readonly projection: Projection;
  readonly ifMatch?: string | undefined;
}

/**
 * A SCIM 2.0 service provider (RFC 7643, RFC 7644), independent of any HTTP
 * framework. `handle` takes a request and resolves to a response; it never
 * throws. Use an adapter (`createNodeHandler`, `createFetchHandler`,
 * `ScimModule` for NestJS) to serve it.
 */
export class ScimServer {
  private readonly lenient: boolean;
  private readonly limits: ScimLimits;
  private readonly queryLimits: QueryLimits;
  private readonly logger: ScimLogger;
  private readonly hooks: ScimHooks;
  private readonly types: readonly CompiledResourceType[];
  private readonly byEndpoint = new Map<string, CompiledResourceType>();
  private readonly byName = new Map<string, CompiledResourceType>();
  private readonly repositories = new Map<CompiledResourceType, ScimRepository>();
  private readonly schemas: readonly SchemaDefinition[];
  private readonly baseUrl: string | undefined;

  constructor(private readonly options: ScimServerOptions) {
    if (typeof options.authenticate !== 'function') {
      throw new TypeError('ScimServer needs an `authenticate` function; see bearerTokenAuth().');
    }
    this.lenient = (options.compatibility ?? 'lenient') === 'lenient';
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (this.limits.defaultCount > this.limits.maxResults) this.limits.defaultCount = this.limits.maxResults;
    this.queryLimits = {
      defaultCount: this.limits.defaultCount,
      maxResults: this.limits.maxResults,
      filter: {
        maxLength: this.limits.maxFilterLength,
        maxDepth: this.limits.maxFilterDepth,
        maxComparisons: this.limits.maxFilterComparisons,
      },
    };
    this.logger = options.logger ?? consoleLogger;
    this.hooks = options.hooks ?? {};
    this.baseUrl = options.baseUrl === undefined ? undefined : trimSlash(options.baseUrl);

    const definitions = options.resourceTypes ?? [UserResourceType, GroupResourceType];
    if (definitions.length === 0) throw new TypeError('ScimServer needs at least one resource type.');
    this.types = definitions.map((definition) => new CompiledResourceType(definition));
    const schemas = new Map<string, SchemaDefinition>();
    for (const type of this.types) {
      const name = type.name.toLowerCase();
      const endpoint = type.endpoint.slice(1).toLowerCase();
      if (this.byName.has(name)) throw new TypeError(`Resource type ${type.name} is defined twice.`);
      if (this.byEndpoint.has(endpoint)) throw new TypeError(`Endpoint ${type.endpoint} is used twice.`);
      this.byName.set(name, type);
      this.byEndpoint.set(endpoint, type);
      for (const schema of [
        type.definition.schema,
        ...type.extensions.map((extension) => extension.schema),
      ]) {
        const known = schemas.get(schema.id.toLowerCase());
        if (known !== undefined && known !== schema) {
          throw new TypeError(`Two different schemas use the id ${schema.id}.`);
        }
        schemas.set(schema.id.toLowerCase(), schema);
      }
      const repository = options.repositories?.[type.name] ?? options.store?.repository(type.definition);
      if (repository === undefined) {
        throw new TypeError(
          `No repository for resource type ${type.name}: pass \`store\` or \`repositories.${type.name}\`.`,
        );
      }
      this.repositories.set(type, repository);
    }
    for (const name of Object.keys(options.repositories ?? {})) {
      if (!this.byName.has(name.toLowerCase()))
        throw new TypeError(`Unknown resource type "${name}" in repositories.`);
    }
    this.schemas = [...schemas.values()];
  }

  /** The resource types this server serves. */
  get resourceTypes(): readonly ResourceTypeDefinition[] {
    return this.types.map((type) => type.definition);
  }

  /** Handles one HTTP request. Never throws: errors become SCIM error responses. */
  async handle(request: ScimHttpRequest): Promise<ScimHttpResponse> {
    const started = performance.now();
    const supplied = header(request.headers, 'x-request-id');
    const requestId = supplied !== undefined && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    let response: ScimHttpResponse;
    try {
      response = await this.dispatch(request, requestId);
    } catch (error) {
      response = this.errorResponse(error, request, requestId);
    }
    this.logger.debug('SCIM request', {
      requestId,
      method: request.method,
      path: request.path,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    });
    return { ...response, headers: { ...response.headers, 'X-Request-Id': requestId } };
  }

  private async dispatch(request: ScimHttpRequest, requestId: string): Promise<ScimHttpResponse> {
    const method = request.method.toUpperCase();
    const head = method === 'HEAD';
    const effective = head ? 'GET' : method;
    const segments = splitPath(request.path);
    const params = new QueryParameters(request.query, this.lenient);
    const baseUrl = this.baseUrlFor(request);
    const same = (segment: string | undefined, name: string) =>
      segment !== undefined &&
      (this.lenient ? segment.toLowerCase() === name.toLowerCase() : segment === name);
    const [first, second, ...rest] = segments;
    if (first === undefined)
      throw ScimError.notFound('No resource at the SCIM root. Try /ServiceProviderConfig.');

    let response: ScimHttpResponse;
    if (same(first, 'ServiceProviderConfig') || same(first, 'ResourceTypes') || same(first, 'Schemas')) {
      allow(effective, ['GET']);
      if (this.options.discoveryRequiresAuthentication ?? true) await this.authenticate(request);
      response = this.discovery(first.toLowerCase(), second, rest, baseUrl);
    } else if (same(first, 'Bulk') && second === undefined) {
      allow(method, ['POST']);
      const context = await this.contextFor(request, requestId, baseUrl);
      response = await this.bulk(context, request);
    } else if (first === '.search' && second === undefined) {
      allow(method, ['POST']);
      const context = await this.contextFor(request, requestId, baseUrl);
      response = await this.rootSearch(context, this.searchBody(request));
    } else if (same(first, 'Me')) {
      const context = await this.contextFor(request, requestId, baseUrl);
      response = await this.me(context, effective, segments.slice(1), request, params);
    } else {
      const type = this.byEndpoint.get(first.toLowerCase());
      if (type === undefined || (!this.lenient && type.endpoint.slice(1) !== first)) {
        throw ScimError.notFound(`No resource type is served at /${first}.`);
      }
      if (rest.length > 0) throw ScimError.notFound(`No resource at ${request.path}.`);
      const context = await this.contextFor(request, requestId, baseUrl);
      response = await this.resourceRoute(type, context, effective, second, request, params);
    }
    if (head) return { status: response.status, headers: response.headers };
    return response;
  }

  private async resourceRoute(
    type: CompiledResourceType,
    context: ScimContext,
    method: string,
    id: string | undefined,
    request: ScimHttpRequest,
    params: QueryParameters,
  ): Promise<ScimHttpResponse> {
    const projection = () =>
      parseProjection(
        { attributes: params.get('attributes'), excludedAttributes: params.get('excludedAttributes') },
        type,
        this.mode,
      );
    const ifMatch = header(request.headers, 'if-match');
    if (id === undefined) {
      allow(method, ['GET', 'POST']);
      if (method === 'GET') return this.list(type, context, queryParameters(params));
      this.checkContentType(request);
      return this.create({ context, type, projection: projection() }, parseJsonBody(request.body));
    }
    if (id === '.search') {
      allow(method, ['POST']);
      return this.list(type, context, this.searchBody(request));
    }
    allow(method, ['GET', 'PUT', 'PATCH', 'DELETE']);
    const input: OperationInput = {
      context,
      type,
      projection: method === 'DELETE' ? {} : projection(),
      ifMatch,
    };
    switch (method) {
      case 'GET':
        return this.get(input, id, header(request.headers, 'if-none-match'));
      case 'PUT':
        this.checkContentType(request);
        return this.replace(input, id, parseJsonBody(request.body));
      case 'PATCH':
        this.checkContentType(request);
        return this.patch(input, id, parseJsonBody(request.body));
      default:
        return this.remove(input, id);
    }
  }

  // ---------------------------------------------------------------- discovery

  private discovery(
    endpoint: string,
    id: string | undefined,
    rest: readonly string[],
    baseUrl: string,
  ): ScimHttpResponse {
    if (rest.length > 0) throw ScimError.notFound('No such discovery resource.');
    if (endpoint === 'serviceproviderconfig') {
      if (id !== undefined) throw ScimError.notFound('No such discovery resource.');
      return json(
        200,
        serviceProviderConfig(
          {
            ...(this.options.documentationUri === undefined
              ? {}
              : { documentationUri: this.options.documentationUri }),
            bulk: {
              supported: this.options.bulk ?? true,
              maxOperations: this.limits.maxBulkOperations,
              maxPayloadSize: this.limits.maxBulkPayloadBytes,
            },
            maxResults: this.limits.maxResults,
            changePassword: this.hooks.setPassword !== undefined,
            authenticationSchemes: this.options.authenticationSchemes ?? [BEARER_TOKEN_SCHEME],
          },
          baseUrl,
        ),
      );
    }
    if (endpoint === 'resourcetypes') {
      const resources = this.types.map((type) => resourceTypeResource(type.definition, baseUrl));
      if (id === undefined) return json(200, listResponse(resources, resources.length, 1));
      const found = this.byName.get(id.toLowerCase());
      if (found === undefined) throw ScimError.notFound(`No resource type named "${id}".`);
      return json(200, resourceTypeResource(found.definition, baseUrl));
    }
    const resources = this.schemas.map((schema) => schemaResource(schema, baseUrl));
    if (id === undefined) return json(200, listResponse(resources, resources.length, 1));
    const found = this.schemas.find((schema) => schema.id.toLowerCase() === id.toLowerCase());
    if (found === undefined) throw ScimError.notFound(`No schema with the id "${id}".`);
    return json(200, schemaResource(found, baseUrl));
  }

  // ---------------------------------------------------------------- resources

  private async create(input: OperationInput, body: unknown): Promise<ScimHttpResponse> {
    const { context, type } = input;
    const normalized = normalizeResourceBody(body, type, this.normalizeOptions(context));
    const attributes = await this.beforeWrite(
      { action: 'create', context, resourceType: type.name, attributes: normalized.attributes },
      type,
      normalized,
    );
    const stored = await this.repository(type).create(context, attributes);
    await this.storePassword(context, type, stored.id, normalized);
    const resource = this.represent(stored, type, context);
    await this.emit([
      { type: 'resource.created', context, resourceType: type.name, id: stored.id, resource },
      ...membershipEvents(type, context, stored.id, undefined, resource),
    ]);
    return this.resourceResponse(201, resource, stored.version, input, true);
  }

  private async get(
    input: OperationInput,
    id: string,
    ifNoneMatch: string | undefined,
  ): Promise<ScimHttpResponse> {
    const stored = await this.repository(input.type).get(input.context, id, { projection: input.projection });
    if (stored === undefined) throw notFound(input.type, id);
    if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, stored.version)) {
      return { status: 304, headers: { ETag: etagOf(stored.version) } };
    }
    return this.resourceResponse(
      200,
      this.represent(stored, input.type, input.context),
      stored.version,
      input,
      false,
    );
  }

  private async replace(input: OperationInput, id: string, body: unknown): Promise<ScimHttpResponse> {
    const { context, type } = input;
    return this.withRetries(input.ifMatch, async () => {
      const current = await this.current(input, id);
      const previous = this.represent(current, type, context);
      const normalized = normalizeResourceBody(body, type, {
        ...this.normalizeOptions(context),
        existing: current.attributes,
      });
      const attributes = await this.beforeWrite(
        {
          action: 'replace',
          context,
          resourceType: type.name,
          id,
          attributes: normalized.attributes,
          previous,
        },
        type,
        normalized,
        current.attributes,
      );
      const stored = await this.repository(type).replace(context, id, attributes, {
        expectedVersion: current.version,
      });
      await this.storePassword(context, type, id, normalized);
      const resource = this.represent(stored, type, context);
      await this.emit(updateEvents(type, context, id, 'replace', previous, resource));
      return this.resourceResponse(200, resource, stored.version, input, false);
    });
  }

  private async patch(input: OperationInput, id: string, body: unknown): Promise<ScimHttpResponse> {
    const { context, type } = input;
    const operations = parsePatchBody(body, {
      lenient: this.lenient,
      maxOperations: this.limits.maxPatchOperations,
    });
    return this.withRetries(input.ifMatch, async () => {
      const current = await this.current(input, id);
      const previous = this.represent(current, type, context);
      const options = this.normalizeOptions(context);
      const patched = applyPatch(current.attributes, operations, type, { ...options, resourceId: id });
      // Values were checked operation by operation; this pass enforces required
      // and immutable attributes and drops read-only values such as `groups`.
      const normalized = normalizeAttributes(patched, type, {
        ...options,
        lenient: true,
        existing: current.attributes,
      });
      if (unchanged(normalized.attributes, current.attributes, type, options)) {
        await this.storePassword(context, type, id, normalized);
        return this.resourceResponse(200, previous, current.version, input, false);
      }
      const attributes = await this.beforeWrite(
        {
          action: 'patch',
          context,
          resourceType: type.name,
          id,
          attributes: normalized.attributes,
          previous,
          operations,
        },
        type,
        normalized,
        current.attributes,
      );
      const stored = await this.repository(type).replace(context, id, attributes, {
        expectedVersion: current.version,
      });
      await this.storePassword(context, type, id, normalized);
      const resource = this.represent(stored, type, context);
      await this.emit(updateEvents(type, context, id, 'patch', previous, resource));
      return this.resourceResponse(200, resource, stored.version, input, false);
    });
  }

  private async remove(input: OperationInput, id: string): Promise<ScimHttpResponse> {
    const { context, type } = input;
    return this.withRetries(input.ifMatch, async () => {
      const current = await this.current(input, id);
      const previous = this.represent(current, type, context);
      await this.hooks.beforeWrite?.({ action: 'delete', context, resourceType: type.name, id, previous });
      const deleted = await this.repository(type).delete(context, id, { expectedVersion: current.version });
      if (!deleted) throw notFound(type, id);
      await this.emit([{ type: 'resource.deleted', context, resourceType: type.name, id, previous }]);
      return { status: 204, headers: {} };
    });
  }

  /** Reads the resource a write applies to and checks If-Match. */
  private async current(input: OperationInput, id: string): Promise<StoredResource> {
    const stored = await this.repository(input.type).get(input.context, id);
    if (stored === undefined) throw notFound(input.type, id);
    if (input.ifMatch !== undefined && !etagMatches(input.ifMatch, stored.version)) {
      throw ScimError.preconditionFailed();
    }
    return stored;
  }

  private async list(
    type: CompiledResourceType,
    context: ScimContext,
    raw: RawListParameters,
  ): Promise<ScimHttpResponse> {
    const query = parseListQuery(raw, type, this.mode, this.queryLimits);
    const result = await this.repository(type).list(context, query);
    const resources = result.resources
      .slice(0, query.count)
      .map((stored) => projectResource(this.represent(stored, type, context), type, query.projection));
    return json(200, listResponse(resources, result.totalResults, query.startIndex));
  }

  /** POST /.search: one result list across all resource types, in registration order. */
  private async rootSearch(context: ScimContext, raw: RawListParameters): Promise<ScimHttpResponse> {
    if (raw.sortBy !== undefined && raw.sortBy !== null && raw.sortBy !== '') {
      throw ScimError.invalidValue('"sortBy" is not supported when searching across resource types.');
    }
    const { startIndex, count } = parsePagination(raw, this.queryLimits);
    const expression =
      typeof raw.filter === 'string' && raw.filter !== ''
        ? parseFilter(raw.filter, this.queryLimits.filter)
        : undefined;
    if (raw.filter !== undefined && raw.filter !== null && raw.filter !== '' && expression === undefined) {
      throw ScimError.invalidFilter('"filter" must be a string.');
    }
    const plans: { type: CompiledResourceType; query: ListQuery; total: number }[] = [];
    let lastError: unknown;
    for (const type of this.types) {
      let filter;
      if (expression !== undefined) {
        try {
          filter = resolveFilter(expression, type, this.mode);
        } catch (error) {
          lastError = error;
          continue;
        }
      }
      const query: ListQuery = {
        ...(filter === undefined ? {} : { filter }),
        startIndex: 1,
        count: 0,
        sortOrder: 'ascending',
        projection: parseProjection(raw, type, { lenient: true }),
      };
      const { totalResults } = await this.repository(type).list(context, query);
      plans.push({ type, query, total: totalResults });
    }
    if (plans.length === 0) throw lastError;
    let offset = startIndex - 1;
    let remaining = count;
    const resources: ScimResource[] = [];
    for (const plan of plans) {
      if (remaining === 0) break;
      if (offset >= plan.total) {
        offset -= plan.total;
        continue;
      }
      const take = Math.min(remaining, plan.total - offset);
      const page = await this.repository(plan.type).list(context, {
        ...plan.query,
        startIndex: offset + 1,
        count: take,
      });
      for (const stored of page.resources.slice(0, take)) {
        resources.push(
          projectResource(this.represent(stored, plan.type, context), plan.type, plan.query.projection),
        );
      }
      remaining -= Math.min(take, page.resources.length);
      offset = 0;
    }
    const total = plans.reduce((sum, plan) => sum + plan.total, 0);
    return json(200, listResponse(resources, total, startIndex));
  }

  private async me(
    context: ScimContext,
    method: string,
    rest: readonly string[],
    request: ScimHttpRequest,
    params: QueryParameters,
  ): Promise<ScimHttpResponse> {
    if (this.options.me === undefined)
      throw ScimError.notImplemented('/Me is not supported by this service provider.');
    if (rest.length > 0) throw ScimError.notFound(`No resource at ${request.path}.`);
    if (method === 'POST') throw ScimError.notImplemented('Creating resources through /Me is not supported.');
    const target = await this.options.me(context);
    if (target === undefined) throw ScimError.notFound('The authenticated subject has no SCIM resource.');
    const type = this.byName.get(target.resourceType.toLowerCase());
    if (type === undefined)
      throw new TypeError(`me() returned the unknown resource type "${target.resourceType}".`);
    return this.resourceRoute(type, context, method, target.id, request, params);
  }

  // ---------------------------------------------------------------- bulk

  private async bulk(context: ScimContext, request: ScimHttpRequest): Promise<ScimHttpResponse> {
    if (!(this.options.bulk ?? true)) throw ScimError.notImplemented('Bulk operations are not supported.');
    if (bodySize(request.body) > this.limits.maxBulkPayloadBytes) {
      throw ScimError.payloadTooLarge(
        `A bulk request can be at most ${this.limits.maxBulkPayloadBytes} bytes.`,
      );
    }
    this.checkContentType(request);
    const bulk = parseBulkRequest(parseJsonBody(request.body), {
      lenient: this.lenient,
      maxOperations: this.limits.maxBulkOperations,
    });
    const operations = bulk.operations;
    const declared = new Set(
      operations.flatMap((operation) =>
        operation.method === 'POST' && operation.bulkId ? [operation.bulkId] : [],
      ),
    );
    const created = new Map<string, string>();
    const failed = new Set<string>();
    const results: (JsonObject | undefined)[] = operations.map(() => undefined);
    let pending = operations.map((_, index) => index);
    let errors = 0;
    const stopAt = bulk.failOnErrors;

    const record = (index: number, operation: BulkOperation, response: ScimHttpResponse): void => {
      const result: JsonObject = { method: operation.method };
      if (operation.bulkId !== undefined) result['bulkId'] = operation.bulkId;
      const location = response.headers['Location'];
      const etag = response.headers['ETag'];
      if (location !== undefined) result['location'] = location;
      if (etag !== undefined) result['version'] = etag;
      result['status'] = String(response.status);
      if (response.status >= 400) {
        result['response'] = response.body;
        errors++;
        if (operation.bulkId !== undefined) failed.add(operation.bulkId);
      } else if (operation.method === 'POST' && operation.bulkId !== undefined && isObject(response.body)) {
        created.set(operation.bulkId, String(response.body['id']));
      }
      results[index] = result;
    };

    outer: while (pending.length > 0) {
      let progressed = false;
      for (const index of [...pending]) {
        const operation = operations[index] as BulkOperation;
        const references = [...bulkReferences(operation)];
        const unknown = references.filter((reference) => !declared.has(reference));
        const broken = references.filter((reference) => failed.has(reference));
        if (unknown.length > 0 || broken.length > 0) {
          const detail =
            unknown.length > 0
              ? `Unknown bulkId reference "bulkId:${unknown[0] as string}".`
              : `The operation with bulkId "${broken[0] as string}" failed.`;
          record(
            index,
            operation,
            this.errorResponse(new ScimError(409, detail), request, context.requestId),
          );
        } else if (references.some((reference) => !created.has(reference))) {
          continue;
        } else {
          record(
            index,
            operation,
            await this.bulkOperation(context, substituteReferences(operation, created)),
          );
        }
        pending = pending.filter((candidate) => candidate !== index);
        progressed = true;
        if (stopAt !== undefined && errors >= stopAt) break outer;
      }
      if (!progressed) {
        for (const index of pending) {
          record(
            index,
            operations[index] as BulkOperation,
            this.errorResponse(
              new ScimError(409, 'The bulkId references of this operation form a cycle.'),
              request,
              context.requestId,
            ),
          );
          if (stopAt !== undefined && errors >= stopAt) break;
        }
        break;
      }
    }
    return json(200, {
      schemas: [SCIM_MESSAGES.bulkResponse],
      Operations: results.filter((result) => result !== undefined),
    });
  }

  private async bulkOperation(context: ScimContext, operation: BulkOperation): Promise<ScimHttpResponse> {
    try {
      const [endpoint, id, ...rest] = splitPath(operation.path);
      const type = endpoint === undefined ? undefined : this.byEndpoint.get(endpoint.toLowerCase());
      if (type === undefined || rest.length > 0)
        throw ScimError.invalidPath(`"${operation.path}" is not a resource path.`);
      const input: OperationInput = { context, type, projection: {}, ifMatch: operation.version };
      if (operation.method === 'POST') {
        if (id !== undefined)
          throw ScimError.invalidPath('A bulk POST path names a resource type, such as "/Users".');
        return await this.create(input, operation.data);
      }
      if (id === undefined)
        throw ScimError.invalidPath(
          `A bulk ${operation.method} path names a resource, such as "/Users/<id>".`,
        );
      if (operation.method === 'PUT') return await this.replace(input, id, operation.data);
      if (operation.method === 'PATCH') return await this.patch(input, id, operation.data);
      return await this.remove(input, id);
    } catch (error) {
      return this.errorResponse(error, undefined, context.requestId);
    }
  }

  // ---------------------------------------------------------------- helpers

  private get mode(): { lenient: boolean } {
    return { lenient: this.lenient };
  }

  private repository(type: CompiledResourceType): ScimRepository {
    return this.repositories.get(type) as ScimRepository;
  }

  private references(context: ScimContext): ReferenceResolver {
    return {
      baseUrl: context.baseUrl,
      endpointOf: (name) => this.byName.get(name.toLowerCase())?.endpoint,
    };
  }

  private represent(stored: StoredResource, type: CompiledResourceType, context: ScimContext): ScimResource {
    return toScimResource(stored, type, this.references(context));
  }

  private resourceResponse(
    status: number,
    resource: ScimResource,
    version: string,
    input: OperationInput,
    created: boolean,
  ): ScimHttpResponse {
    const headers: Record<string, string> = { ETag: etagOf(version) };
    if (created) headers['Location'] = locationOf(input.context.baseUrl, input.type.endpoint, resource.id);
    return json(status, projectResource(resource, input.type, input.projection), headers);
  }

  private normalizeOptions(context: ScimContext) {
    return {
      lenient: this.lenient,
      onUnknownAttribute: (path: string) => {
        this.logger.debug('Ignored an attribute the schema does not define', {
          requestId: context.requestId,
          attribute: path,
        });
      },
    };
  }

  private async beforeWrite(
    event: BeforeWriteEvent,
    type: CompiledResourceType,
    normalized: NormalizedAttributes,
    existing?: JsonObject,
  ): Promise<JsonObject> {
    const replacement = await this.hooks.beforeWrite?.(event);
    if (replacement === undefined) return normalized.attributes;
    return normalizeAttributes(replacement, type, {
      ...this.normalizeOptions(event.context),
      ...(existing === undefined ? {} : { existing }),
    }).attributes;
  }

  private async storePassword(
    context: ScimContext,
    type: CompiledResourceType,
    id: string,
    normalized: NormalizedAttributes,
  ): Promise<void> {
    if (normalized.password === undefined) return;
    if (this.hooks.setPassword === undefined) {
      this.logger.debug('Discarded a password: no setPassword hook is configured', {
        requestId: context.requestId,
      });
      return;
    }
    await this.hooks.setPassword(context, { resourceType: type.name, id, password: normalized.password });
  }

  private async emit(events: readonly ScimEvent[]): Promise<void> {
    const handler = this.hooks.onEvent;
    if (handler === undefined) return;
    for (const event of events) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error('An onEvent hook failed', {
          requestId: event.context.requestId,
          event: event.type,
          error: describe(error),
        });
      }
    }
  }

  private async withRetries(
    ifMatch: string | undefined,
    run: () => Promise<ScimHttpResponse>,
  ): Promise<ScimHttpResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (!isVersionConflict(error)) throw error;
        if (ifMatch !== undefined) throw ScimError.preconditionFailed();
        if (attempt >= MAX_WRITE_ATTEMPTS) {
          throw ScimError.conflict('The resource is being changed concurrently; retry the request.');
        }
        // Jittered exponential backoff spreads out writers that keep colliding.
        await new Promise((resolve) => {
          setTimeout(resolve, Math.random() * Math.min(200, 5 * 2 ** attempt));
        });
      }
    }
  }

  private async authenticate(request: ScimHttpRequest): Promise<ScimPrincipal> {
    const principal = await this.options.authenticate(request);
    if (principal === undefined) throw ScimError.unauthorized();
    if (typeof principal.tenantId !== 'string' || principal.tenantId === '') {
      throw new TypeError('authenticate() returned a principal without a tenantId.');
    }
    return principal;
  }

  private async contextFor(
    request: ScimHttpRequest,
    requestId: string,
    baseUrl: string,
  ): Promise<ScimContext> {
    const principal = await this.authenticate(request);
    return {
      tenantId: principal.tenantId,
      principal,
      requestId,
      baseUrl,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
  }

  private baseUrlFor(request: ScimHttpRequest): string {
    const baseUrl = this.baseUrl ?? (request.baseUrl === undefined ? undefined : trimSlash(request.baseUrl));
    if (baseUrl === undefined) {
      throw new TypeError('The SCIM base URL is unknown: set the `baseUrl` option or pass request.baseUrl.');
    }
    return baseUrl;
  }

  private searchBody(request: ScimHttpRequest): RawListParameters {
    this.checkContentType(request);
    const body = parseJsonBody(request.body);
    if (!isObject(body)) throw ScimError.invalidSyntax('The search request must be a JSON object.');
    if (!this.lenient) {
      const schemas = body['schemas'];
      if (!Array.isArray(schemas) || !schemas.includes(SCIM_MESSAGES.searchRequest)) {
        throw ScimError.invalidSyntax(`"schemas" must include ${SCIM_MESSAGES.searchRequest}.`);
      }
    }
    return body;
  }

  private checkContentType(request: ScimHttpRequest): void {
    if (this.lenient) return;
    const type = header(request.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== undefined && type !== SCIM_CONTENT_TYPE && type !== 'application/json') {
      throw ScimError.unsupportedMediaType(`Send ${SCIM_CONTENT_TYPE} or application/json, not ${type}.`);
    }
  }

  private errorResponse(
    error: unknown,
    request: ScimHttpRequest | undefined,
    requestId: string,
  ): ScimHttpResponse {
    if (isScimError(error)) {
      if (error.status >= 500) this.logger.error(error.detail, { requestId, error: describe(error) });
      return json(error.status, error.toJSON(), { ...error.headers });
    }
    this.logger.error('Unexpected error while handling a SCIM request', {
      requestId,
      ...(request === undefined ? {} : { method: request.method, path: request.path }),
      error: describe(error),
    });
    return json(500, ScimError.internal(`An internal error occurred (request ${requestId}).`).toJSON());
  }
}

/**
 * Whether a PATCH result equals the stored resource. Stored data that does not
 * validate on its own (a custom repository may hold anything) counts as changed.
 */
function unchanged(
  next: JsonObject,
  stored: JsonObject,
  type: CompiledResourceType,
  options: { lenient: boolean },
): boolean {
  try {
    return deepEqual(next, normalizeAttributes(stored, type, { ...options, lenient: true }).attributes);
  } catch {
    return false;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): ScimHttpResponse {
  return { status, headers: { 'Content-Type': `${SCIM_CONTENT_TYPE}; charset=utf-8`, ...headers }, body };
}

function listResponse(resources: readonly unknown[], totalResults: number, startIndex: number): JsonObject {
  return {
    schemas: [SCIM_MESSAGES.listResponse],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function allow(method: string, allowed: readonly string[]): void {
  if (!allowed.includes(method)) {
    throw ScimError.methodNotAllowed(`${method} is not allowed here; use ${allowed.join(' or ')}.`, allowed);
  }
}

function notFound(type: CompiledResourceType, id: string): ScimError {
  return ScimError.notFound(`${type.name} "${id}" was not found.`);
}

function splitPath(path: string): string[] {
  const withoutQuery = path.split('?')[0] ?? '';
  return withoutQuery
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw ScimError.notFound(`The path segment "${segment}" is not valid percent-encoding.`);
      }
    });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function queryParameters(params: QueryParameters): RawListParameters {
  return {
    filter: params.get('filter'),
    startIndex: params.get('startIndex'),
    count: params.get('count'),
    sortBy: params.get('sortBy'),
    sortOrder: params.get('sortOrder'),
    attributes: params.get('attributes'),
    excludedAttributes: params.get('excludedAttributes'),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function members(resource: ScimResource | undefined): Map<string, MemberReference> {
  const result = new Map<string, MemberReference>();
  const list = resource?.['members'];
  if (!Array.isArray(list)) return result;
  for (const member of list) {
    if (!isObject(member) || typeof member['value'] !== 'string') continue;
    result.set(member['value'], {
      value: member['value'],
      ...(typeof member['type'] === 'string' ? { type: member['type'] } : {}),
    });
  }
  return result;
}

function membershipEvents(
  type: CompiledResourceType,
  context: ScimContext,
  id: string,
  previous: ScimResource | undefined,
  resource: ScimResource,
): ScimEvent[] {
  if (!type.isGroup) return [];
  const before = members(previous);
  const after = members(resource);
  const added = [...after.values()].filter((member) => !before.has(member.value));
  const removed = [...before.values()].filter((member) => !after.has(member.value));
  const events: ScimEvent[] = [];
  if (added.length > 0) {
    events.push({ type: 'group.members.added', context, resourceType: type.name, id, members: added });
  }
  if (removed.length > 0) {
    events.push({ type: 'group.members.removed', context, resourceType: type.name, id, members: removed });
  }
  return events;
}

function updateEvents(
  type: CompiledResourceType,
  context: ScimContext,
  id: string,
  operation: 'replace' | 'patch',
  previous: ScimResource,
  resource: ScimResource,
): ScimEvent[] {
  const events: ScimEvent[] = [
    { type: 'resource.updated', context, resourceType: type.name, id, operation, resource, previous },
  ];
  if (type.isUser) {
    const wasActive = previous['active'] !== false;
    const isActive = resource['active'] !== false;
    if (wasActive && !isActive)
      events.push({ type: 'user.deactivated', context, resourceType: type.name, id, resource });
    if (!wasActive && isActive)
      events.push({ type: 'user.reactivated', context, resourceType: type.name, id, resource });
  }
  events.push(...membershipEvents(type, context, id, previous, resource));
  return events;
}
