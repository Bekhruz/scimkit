import { ScimError } from '../errors.js';
import { type AttributeDefinition, findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import {
  type AttributePathSyntax,
  type FilterExpression,
  type FilterLiteral,
  type ResolvedFilter,
  type ResolvedLiteral,
  type ResolvedPath,
  targetDefinition,
} from './ast.js';

export interface ResolveOptions {
  /**
   * Lenient resolution accepts what real clients send: extension attributes
   * without their URN prefix when unambiguous, and literals of the wrong JSON
   * type when they convert cleanly (`active eq "true"`).
   */
  lenient: boolean;
}

/** Throws unless the path refers to a value that can be filtered and sorted on. */
export function assertQueryable(
  path: ResolvedPath,
  text: string,
  onError: (detail: string) => ScimError,
): void {
  const target = targetDefinition(path);
  const computed =
    target.name === '$ref' ||
    (path.attribute.name === 'meta' &&
      (path.subAttribute?.name === 'location' || path.subAttribute?.name === 'version'));
  if (target.returned === 'never' || computed) throw onError(`"${text}" cannot be used in a query.`);
}

export function pathText(syntax: AttributePathSyntax): string {
  return `${syntax.uri === undefined ? '' : `${syntax.uri}:`}${syntax.attribute}${
    syntax.subAttribute === undefined ? '' : `.${syntax.subAttribute}`
  }`;
}

/**
 * Resolves an attribute path against a resource type: the URN prefix must be
 * one of its schemas, the attribute must exist in that schema and a
 * sub-attribute must exist in the (complex) attribute.
 */
export function resolveAttributePath(
  syntax: AttributePathSyntax,
  type: CompiledResourceType,
  options: ResolveOptions,
  onError: (detail: string) => ScimError,
): ResolvedPath {
  const text = pathText(syntax);
  let located;
  if (syntax.uri !== undefined) {
    if (syntax.uri.toLowerCase() !== type.coreUrn.toLowerCase() && type.extension(syntax.uri) === undefined) {
      throw onError(`Unknown schema "${syntax.uri}" in "${text}".`);
    }
    located = type.attributeIn(syntax.uri, syntax.attribute);
  } else {
    located = type.attributeIn(type.coreUrn, syntax.attribute);
    if (located === undefined && options.lenient) {
      const candidates = type.extensions
        .map((extension) => type.attributeIn(extension.schema.id, syntax.attribute))
        .filter((candidate) => candidate !== undefined);
      if (candidates.length === 1) located = candidates[0];
    }
  }
  if (located === undefined) throw onError(`Unknown attribute "${text}".`);
  if (syntax.subAttribute === undefined) {
    return { schema: located.schema, extension: located.extension, attribute: located.definition };
  }
  if (located.definition.type !== 'complex') {
    throw onError(`"${located.definition.name}" has no sub-attributes ("${text}").`);
  }
  const subAttribute = findSubAttribute(located.definition, syntax.subAttribute);
  if (subAttribute === undefined) throw onError(`Unknown attribute "${text}".`);
  return {
    schema: located.schema,
    extension: located.extension,
    attribute: located.definition,
    subAttribute,
  };
}

/**
 * Checks a parsed filter against a resource type and coerces its literals to
 * the attribute types. Throws a 400 `invalidFilter` {@link ScimError} for
 * unknown attributes and for comparisons the attribute type does not support.
 */
export function resolveFilter(
  expression: FilterExpression,
  type: CompiledResourceType,
  options: ResolveOptions,
): ResolvedFilter {
  return resolveNode(expression, type, options, undefined);
}

/**
 * Resolves the filter of a value path such as `emails[type eq "work"]`: its
 * attribute names are sub-attributes of `element`'s attribute.
 */
export function resolveValueFilter(
  expression: FilterExpression,
  type: CompiledResourceType,
  options: ResolveOptions,
  element: ResolvedPath,
): ResolvedFilter {
  return resolveNode(expression, type, options, element);
}

function resolveNode(
  expression: FilterExpression,
  type: CompiledResourceType,
  options: ResolveOptions,
  element: ResolvedPath | undefined,
): ResolvedFilter {
  switch (expression.type) {
    case 'and':
    case 'or': {
      const filters: ResolvedFilter[] = [];
      for (const side of [expression.left, expression.right]) {
        const resolved = resolveNode(side, type, options, element);
        if (resolved.type === expression.type) filters.push(...resolved.filters);
        else filters.push(resolved);
      }
      return { type: expression.type, filters };
    }
    case 'not':
      return { type: 'not', filter: resolveNode(expression.expression, type, options, element) };
    case 'valuePath': {
      const path = resolveAttributePath(expression.path, type, options, ScimError.invalidFilter);
      if (path.attribute.type !== 'complex') {
        throw ScimError.invalidFilter(
          `"${pathText(expression.path)}" is not a complex attribute and cannot take a value filter.`,
        );
      }
      return { type: 'valuePath', path, filter: resolveNode(expression.expression, type, options, path) };
    }
    case 'present': {
      const path = resolvePath(expression.path, type, options, element);
      assertQueryable(path, pathText(expression.path), ScimError.invalidFilter);
      return { type: 'present', path };
    }
    case 'compare': {
      let path = resolvePath(expression.path, type, options, element);
      const text = pathText(expression.path);
      if (path.subAttribute === undefined && path.attribute.type === 'complex' && element === undefined) {
        // `emails eq "x"` and `manager eq "id"` compare the value sub-attribute.
        const value = findSubAttribute(path.attribute, 'value');
        if (value === undefined)
          throw ScimError.invalidFilter(`"${text}" is complex and cannot be compared.`);
        path = { ...path, subAttribute: value };
      }
      assertQueryable(path, text, ScimError.invalidFilter);
      if (expression.value === null) {
        if (expression.operator === 'eq') return { type: 'not', filter: { type: 'present', path } };
        if (expression.operator === 'ne') return { type: 'present', path };
        throw ScimError.invalidFilter(`"${expression.operator}" cannot compare with null ("${text}").`);
      }
      if (typeof expression.value === 'string' && expression.value.includes('\u0000')) {
        throw ScimError.invalidFilter(`Filter values cannot contain the null character ("${text}").`);
      }
      const value = coerceLiteral(
        targetDefinition(path),
        expression.operator,
        expression.value,
        text,
        options,
      );
      return { type: 'compare', path, operator: expression.operator, value };
    }
  }
}

function resolvePath(
  syntax: AttributePathSyntax,
  type: CompiledResourceType,
  options: ResolveOptions,
  element: ResolvedPath | undefined,
): ResolvedPath {
  if (element === undefined) return resolveAttributePath(syntax, type, options, ScimError.invalidFilter);
  if (syntax.uri !== undefined || syntax.subAttribute !== undefined) {
    throw ScimError.invalidFilter(
      `Inside "${element.attribute.name}[...]" use sub-attribute names only, not "${pathText(syntax)}".`,
    );
  }
  const subAttribute = findSubAttribute(element.attribute, syntax.attribute);
  if (subAttribute === undefined) {
    throw ScimError.invalidFilter(`Unknown attribute "${element.attribute.name}.${syntax.attribute}".`);
  }
  return { ...element, subAttribute };
}

const ORDERING = new Set(['gt', 'ge', 'lt', 'le']);
const SUBSTRING = new Set(['co', 'sw', 'ew']);

function coerceLiteral(
  definition: AttributeDefinition,
  operator: string,
  literal: Exclude<FilterLiteral, null>,
  text: string,
  options: ResolveOptions,
): ResolvedLiteral {
  const fail = (detail: string): never => {
    throw ScimError.invalidFilter(`${detail} ("${text}").`);
  };
  switch (definition.type) {
    case 'boolean': {
      if (operator !== 'eq' && operator !== 'ne') fail(`Boolean attributes support only eq and ne`);
      if (typeof literal === 'boolean') return literal;
      if (options.lenient && typeof literal === 'string' && /^(true|false)$/i.test(literal)) {
        return literal.toLowerCase() === 'true';
      }
      return fail('Expected true or false');
    }
    case 'integer':
    case 'decimal': {
      if (SUBSTRING.has(operator)) fail(`Numeric attributes do not support ${operator}`);
      let number = literal;
      if (options.lenient && typeof literal === 'string' && literal.trim() !== '') number = Number(literal);
      if (typeof number !== 'number' || !Number.isFinite(number)) return fail('Expected a number');
      if (definition.type === 'integer' && !Number.isInteger(number)) return fail('Expected an integer');
      return number;
    }
    case 'dateTime': {
      if (SUBSTRING.has(operator)) fail(`Date-time attributes do not support ${operator}`);
      if (typeof literal !== 'string' || !isDateTime(literal)) return fail('Expected an xsd:dateTime string');
      return literal;
    }
    case 'binary':
      if (ORDERING.has(operator)) fail(`Binary attributes do not support ${operator}`);
      if (typeof literal === 'string') return literal;
      return fail('Expected a string');
    default:
      if (typeof literal === 'string') return literal;
      if (options.lenient) return String(literal);
      return fail('Expected a string');
  }
}

/** xsd:dateTime, as used by SCIM: `2024-05-01T12:00:00Z`, fractional seconds and offsets optional. */
const DATE_TIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function isDateTime(value: string): boolean {
  return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}
