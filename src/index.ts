// scimkit: SCIM 2.0 (RFC 7643, RFC 7644) service provider for Node.js.

export { SCIM_CONTENT_TYPE, SCIM_MESSAGES, SCIM_SCHEMAS } from './constants.js';
export {
  isScimError,
  isVersionConflict,
  ScimError,
  type ScimErrorBody,
  type ScimErrorType,
  VersionConflictError,
} from './errors.js';

export {
  type AttributeDefinition,
  type AttributeInput,
  type AttributeOverrides,
  type AttributeType,
  customizeSchema,
  defineAttribute,
  defineSchema,
  type Mutability,
  type Returned,
  type SchemaDefinition,
  type SchemaInput,
  type Uniqueness,
} from './schema/definitions.js';
export { COMMON_ATTRIBUTES, ENTERPRISE_USER_SCHEMA, GROUP_SCHEMA, USER_SCHEMA } from './schema/core.js';
export {
  defineResourceType,
  GroupResourceType,
  type ResourceTypeDefinition,
  type ResourceTypeInput,
  type SchemaExtension,
  UserResourceType,
} from './schema/resource-type.js';

export type {
  AttributePathSyntax,
  CompareOperator,
  FilterExpression,
  FilterLiteral,
  ResolvedFilter,
  ResolvedLiteral,
  ResolvedPath,
} from './filter/ast.js';
export { targetDefinition } from './filter/ast.js';
export { type FilterParseLimits, parseFilter, stringifyFilter } from './filter/parser.js';
export { compareValue, evaluateFilter, isPresent } from './filter/evaluate.js';
export { simpleEquality, type SimpleEquality } from './filter/simple.js';

export { type PatchOperation, type PatchOperationName } from './patch/apply.js';
export type { JsonObject } from './resource/json.js';
export type { AttributeSelection, Projection } from './resource/projection.js';
export type { ScimMeta, ScimResource, StoredResource } from './resource/representation.js';

export type {
  ListQuery,
  ListResult,
  ReadOptions,
  ScimContext,
  ScimPrincipal,
  ScimRepository,
  ScimStore,
  SortOrder,
  WriteOptions,
} from './store/repository.js';
export { MemoryScimStore, type MemoryScimStoreOptions } from './store/memory.js';

export { type MeTarget, type ScimLimits, ScimServer, type ScimServerOptions } from './protocol/server.js';
export type {
  Authenticator,
  BeforeWriteEvent,
  HeaderValues,
  MemberReference,
  QueryValues,
  ScimEvent,
  ScimHooks,
  ScimHttpRequest,
  ScimHttpResponse,
  ScimLogger,
  WriteAction,
} from './protocol/types.js';
export { type AuthenticationScheme, BEARER_TOKEN_SCHEME } from './protocol/discovery.js';
export { consoleLogger, silentLogger } from './protocol/http.js';

export {
  bearerTokenAuth,
  type IssuedToken,
  MemoryTokenStore,
  readBearerToken,
  type ScimTokenRecord,
  ScimTokens,
  type ScimTokensOptions,
  type ScimTokenStore,
  staticTokenAuth,
} from './auth/tokens.js';

export { createNodeHandler, type NodeHandlerOptions } from './adapters/node.js';
export { createFetchHandler, type FetchHandlerOptions } from './adapters/fetch.js';
