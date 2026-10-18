import { ScimError } from '../errors.js';
import { type ResolvedPath } from '../filter/ast.js';
import { parseAttributePath, parseFilter, type FilterParseLimits } from '../filter/parser.js';
import { assertQueryable, resolveAttributePath, resolveFilter } from '../filter/resolve.js';
import { parseAttributeSelection, type Projection } from '../resource/projection.js';
import { findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import type { ListQuery, SortOrder } from '../store/repository.js';

/** List parameters before they are resolved against a resource type. */
export interface RawListParameters {
  filter?: unknown;
  startIndex?: unknown;
  count?: unknown;
  sortBy?: unknown;
  sortOrder?: unknown;
  attributes?: unknown;
  excludedAttributes?: unknown;
}

export interface QueryLimits {
  defaultCount: number;
  maxResults: number;
  filter: FilterParseLimits;
}

function integer(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(number)) throw ScimError.invalidValue(`"${name}" must be an integer.`);
  return number;
}

/** Splits `attributes` given as "a,b" (query string) or ["a", "b"] (search body). */
export function attributeList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.split(',').filter((entry) => entry.trim() !== '');
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.flatMap((entry) => entry.split(',')).filter((entry) => entry.trim() !== '');
  }
  throw ScimError.invalidValue(`"${name}" must be a comma-separated string or an array of strings.`);
}

export function parseProjection(
  raw: Pick<RawListParameters, 'attributes' | 'excludedAttributes'>,
  type: CompiledResourceType,
  options: { lenient: boolean },
): Projection {
  const attributes = attributeList(raw.attributes, 'attributes');
  const excluded = attributeList(raw.excludedAttributes, 'excludedAttributes');
  return {
    ...(attributes === undefined ? {} : { attributes: parseAttributeSelection(attributes, type, options) }),
    ...(excluded === undefined
      ? {}
      : { excludedAttributes: parseAttributeSelection(excluded, type, options) }),
  };
}

export function parseSortOrder(value: unknown): SortOrder {
  if (value === undefined || value === null || value === '') return 'ascending';
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'ascending' || lower === 'descending') return lower;
  }
  throw ScimError.invalidValue('"sortOrder" must be "ascending" or "descending".');
}

/** Pagination per RFC 7644 §3.4.2.4: startIndex below 1 means 1, negative count means 0. */
export function parsePagination(
  raw: Pick<RawListParameters, 'startIndex' | 'count'>,
  limits: QueryLimits,
): { startIndex: number; count: number } {
  const startIndex = Math.max(1, integer(raw.startIndex, 'startIndex') ?? 1);
  const requested = integer(raw.count, 'count') ?? limits.defaultCount;
  return { startIndex, count: Math.min(Math.max(0, requested), limits.maxResults) };
}

/** Resolves a sortBy attribute: singular values, sub-attributes and multi-valued attributes with a value. */
export function parseSortBy(
  value: unknown,
  type: CompiledResourceType,
  options: { lenient: boolean },
): ResolvedPath | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw ScimError.invalidValue('"sortBy" must be an attribute path.');
  const path = resolveAttributePath(
    parseAttributePath(value.trim(), ScimError.invalidValue),
    type,
    options,
    ScimError.invalidValue,
  );
  assertQueryable(path, value, ScimError.invalidValue);
  const attribute = path.attribute;
  if (attribute.type === 'complex' && path.subAttribute === undefined) {
    if (!attribute.multiValued || findSubAttribute(attribute, 'value') === undefined) {
      throw ScimError.invalidValue(`Cannot sort by the complex attribute "${value}".`);
    }
    return {
      ...path,
      subAttribute: findSubAttribute(attribute, 'value') as NonNullable<ResolvedPath['subAttribute']>,
    };
  }
  if (path.subAttribute?.multiValued === true) throw ScimError.invalidValue(`Cannot sort by "${value}".`);
  return path;
}

/** Validates the parameters of a list or search request against a resource type. */
export function parseListQuery(
  raw: RawListParameters,
  type: CompiledResourceType,
  options: { lenient: boolean },
  limits: QueryLimits,
): ListQuery {
  let filter;
  if (raw.filter !== undefined && raw.filter !== null && raw.filter !== '') {
    if (typeof raw.filter !== 'string') throw ScimError.invalidFilter('"filter" must be a string.');
    filter = resolveFilter(parseFilter(raw.filter, limits.filter), type, options);
  }
  const sortBy = parseSortBy(raw.sortBy, type, options);
  return {
    ...(filter === undefined ? {} : { filter }),
    ...parsePagination(raw, limits),
    ...(sortBy === undefined ? {} : { sortBy }),
    sortOrder: parseSortOrder(raw.sortOrder),
    projection: parseProjection(raw, type, options),
  };
}
