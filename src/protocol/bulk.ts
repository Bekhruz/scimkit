import { SCIM_MESSAGES } from '../constants.js';
import { ScimError } from '../errors.js';
import { isObject } from '../resource/json.js';

export type BulkMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BulkOperation {
  readonly method: BulkMethod;
  readonly bulkId?: string;
  readonly version?: string;
  readonly path: string;
  readonly data?: unknown;
}

export interface BulkRequest {
  readonly failOnErrors?: number;
  readonly operations: readonly BulkOperation[];
}

const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Checks the envelope of a bulk request (RFC 7644 §3.7). */
export function parseBulkRequest(
  body: unknown,
  options: { lenient: boolean; maxOperations: number },
): BulkRequest {
  if (!isObject(body)) throw ScimError.invalidSyntax('The request body must be a JSON object.');
  const schemas = body['schemas'];
  if (!options.lenient && (!Array.isArray(schemas) || !schemas.includes(SCIM_MESSAGES.bulkRequest))) {
    throw ScimError.invalidSyntax(`"schemas" must include ${SCIM_MESSAGES.bulkRequest}.`);
  }
  const failOnErrors = body['failOnErrors'];
  if (failOnErrors !== undefined && (!Number.isInteger(failOnErrors) || (failOnErrors as number) < 1)) {
    throw ScimError.invalidValue('"failOnErrors" must be a positive integer.');
  }
  const operations = body['Operations'];
  if (!Array.isArray(operations) || operations.length === 0) {
    throw ScimError.invalidSyntax('"Operations" must be a non-empty array.');
  }
  if (operations.length > options.maxOperations) {
    throw ScimError.payloadTooLarge(`A bulk request can have at most ${options.maxOperations} operations.`);
  }
  const bulkIds = new Set<string>();
  const parsed = operations.map((operation, index): BulkOperation => {
    const position = `Operation ${index + 1}`;
    if (!isObject(operation)) throw ScimError.invalidSyntax(`${position} must be an object.`);
    const method = typeof operation['method'] === 'string' ? operation['method'].toUpperCase() : undefined;
    if (method === undefined || !METHODS.has(method)) {
      throw ScimError.invalidSyntax(`${position} has an unknown "method"; use POST, PUT, PATCH or DELETE.`);
    }
    const path = operation['path'];
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw ScimError.invalidSyntax(`${position} needs a "path" such as "/Users".`);
    }
    const bulkId = operation['bulkId'];
    if (bulkId !== undefined && (typeof bulkId !== 'string' || bulkId === '')) {
      throw ScimError.invalidSyntax(`${position} has an invalid "bulkId".`);
    }
    if (method === 'POST' && bulkId === undefined && !options.lenient) {
      throw ScimError.invalidSyntax(`${position} is a POST and needs a "bulkId".`);
    }
    if (typeof bulkId === 'string') {
      if (bulkIds.has(bulkId)) throw ScimError.invalidValue(`The bulkId "${bulkId}" is used twice.`);
      bulkIds.add(bulkId);
    }
    const version = operation['version'];
    if (version !== undefined && typeof version !== 'string') {
      throw ScimError.invalidSyntax(`${position} has a "version" that is not a string.`);
    }
    if (method !== 'DELETE' && operation['data'] === undefined) {
      throw ScimError.invalidSyntax(`${position} (${method}) needs "data".`);
    }
    return {
      method: method as BulkMethod,
      path,
      ...(typeof bulkId === 'string' ? { bulkId } : {}),
      ...(version === undefined ? {} : { version }),
      ...(operation['data'] === undefined ? {} : { data: operation['data'] }),
    };
  });
  return {
    ...(failOnErrors === undefined ? {} : { failOnErrors: failOnErrors as number }),
    operations: parsed,
  };
}

const REFERENCE = /^bulkId:(.+)$/;

/** The bulkIds an operation refers to, in its path and anywhere in its data. */
export function bulkReferences(operation: BulkOperation): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = REFERENCE.exec(value);
      if (match?.[1] !== undefined) found.add(match[1]);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isObject(value)) {
      Object.values(value).forEach(visit);
    }
  };
  for (const segment of operation.path.split('/')) visit(decodeSegment(segment));
  visit(operation.data);
  return found;
}

/** Replaces `bulkId:<id>` references with the ids of the resources those operations created. */
export function substituteReferences(
  operation: BulkOperation,
  created: ReadonlyMap<string, string>,
): BulkOperation {
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const match = REFERENCE.exec(value);
      return match?.[1] !== undefined && created.has(match[1]) ? created.get(match[1]) : value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (isObject(value))
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, replace(inner)]));
    return value;
  };
  const path = operation.path
    .split('/')
    .map((segment) => {
      const replaced = replace(decodeSegment(segment));
      return typeof replaced === 'string' && replaced !== decodeSegment(segment)
        ? encodeURIComponent(replaced)
        : segment;
    })
    .join('/');
  return {
    ...operation,
    path,
    ...(operation.data === undefined ? {} : { data: replace(operation.data) }),
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
