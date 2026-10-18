import type { AttributeDefinition } from '../schema/definitions.js';
import { findSubAttribute } from '../schema/definitions.js';
import {
  type CompareOperator,
  type ResolvedFilter,
  type ResolvedLiteral,
  type ResolvedPath,
  targetDefinition,
} from './ast.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored value as text: strings as they are, anything else as JSON. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** RFC 7644 "pr": the attribute has a non-empty value. */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.some(isPresent);
  if (isObject(value)) return Object.values(value).some(isPresent);
  return true;
}

/** The value at the top of a path: the attribute in the resource or in its extension object. */
function attributeValue(resource: Json, path: ResolvedPath): unknown {
  const container = path.extension ? resource[path.schema] : resource;
  return isObject(container) ? container[path.attribute.name] : undefined;
}

/** The values a comparison looks at, and whether there can be several. */
function valuesAt(resource: Json, path: ResolvedPath): { values: unknown[]; multi: boolean } {
  const value = attributeValue(resource, path);
  const sub = path.subAttribute;
  if (sub === undefined) {
    if (path.attribute.multiValued) return { values: Array.isArray(value) ? value : [], multi: true };
    return { values: [value], multi: false };
  }
  if (path.attribute.multiValued) {
    const elements = Array.isArray(value) ? value : [];
    return { values: elements.flatMap((element) => subValues(element, sub)), multi: true };
  }
  if (sub.multiValued) return { values: subValues(value, sub), multi: true };
  return { values: [isObject(value) ? value[sub.name] : undefined], multi: false };
}

function subValues(element: unknown, sub: AttributeDefinition): unknown[] {
  const value = isObject(element) ? element[sub.name] : undefined;
  return sub.multiValued ? (Array.isArray(value) ? value : []) : [value];
}

/**
 * Evaluates a resolved filter against a resource in its SCIM representation
 * (canonical attribute names, extension objects keyed by schema URN). The
 * semantics are those of the PostgreSQL store: comparisons on a multi-valued
 * attribute match when any value matches; `ne` matches an absent singular value.
 */
export function evaluateFilter(filter: ResolvedFilter, resource: Json): boolean {
  switch (filter.type) {
    case 'and':
      return filter.filters.every((inner) => evaluateFilter(inner, resource));
    case 'or':
      return filter.filters.some((inner) => evaluateFilter(inner, resource));
    case 'not':
      return !evaluateFilter(filter.filter, resource);
    case 'present': {
      const { values } = valuesAt(resource, filter.path);
      return values.some(isPresent);
    }
    case 'compare': {
      const { values, multi } = valuesAt(resource, filter.path);
      const definition = targetDefinition(filter.path);
      if (!multi) return compareValue(values[0], filter.operator, filter.value, definition);
      return values.some((value) => compareValue(value, filter.operator, filter.value, definition));
    }
    case 'valuePath': {
      const value = attributeValue(resource, filter.path);
      const elements = Array.isArray(value) ? value : isObject(value) ? [value] : [];
      return elements.some((element) => isObject(element) && evaluateElement(filter.filter, element));
    }
  }
}

/** Evaluates a value filter (the part inside `emails[...]`) against one element. */
export function evaluateElement(filter: ResolvedFilter, element: Json): boolean {
  switch (filter.type) {
    case 'and':
      return filter.filters.every((inner) => evaluateElement(inner, element));
    case 'or':
      return filter.filters.some((inner) => evaluateElement(inner, element));
    case 'not':
      return !evaluateElement(filter.filter, element);
    case 'present':
    case 'compare': {
      const sub = filter.path.subAttribute;
      /* v8 ignore next -- resolution always sets the sub-attribute inside a value filter */
      if (sub === undefined) return false;
      const values = subValues(element, sub);
      if (filter.type === 'present') return values.some(isPresent);
      if (!sub.multiValued) return compareValue(values[0], filter.operator, filter.value, sub);
      return values.some((value) => compareValue(value, filter.operator, filter.value, sub));
    }
    /* v8 ignore next 2 -- the parser rejects nested value filters */
    case 'valuePath':
      return false;
  }
}

/** Compares one stored value with a filter literal, honouring type and case-exactness. */
export function compareValue(
  value: unknown,
  operator: CompareOperator,
  literal: ResolvedLiteral,
  definition: AttributeDefinition,
): boolean {
  if (value === undefined || value === null) return operator === 'ne';
  switch (definition.type) {
    case 'boolean':
      return operator === 'eq' ? value === literal : value !== literal;
    case 'integer':
    case 'decimal': {
      const number = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(number)) return operator === 'ne';
      return order(number - (literal as number), operator);
    }
    case 'dateTime': {
      const left = Date.parse(textOf(value));
      const right = Date.parse(String(literal));
      if (Number.isNaN(left)) return operator === 'ne';
      return order(left - right, operator);
    }
    default: {
      let left = textOf(value);
      let right = String(literal);
      if (!definition.caseExact) {
        left = left.toLowerCase();
        right = right.toLowerCase();
      }
      switch (operator) {
        case 'co':
          return left.includes(right);
        case 'sw':
          return left.startsWith(right);
        case 'ew':
          return left.endsWith(right);
        default:
          return order(left === right ? 0 : left < right ? -1 : 1, operator);
      }
    }
  }
}

function order(difference: number, operator: CompareOperator): boolean {
  switch (operator) {
    case 'eq':
      return difference === 0;
    case 'ne':
      return difference !== 0;
    case 'gt':
      return difference > 0;
    case 'ge':
      return difference >= 0;
    case 'lt':
      return difference < 0;
    case 'le':
      return difference <= 0;
    /* v8 ignore next 2 -- substring operators are handled by the caller */
    default:
      return false;
  }
}

/**
 * The value a resource sorts by (RFC 7644 §3.4.2.3): the attribute itself, or
 * for a multi-valued attribute the `value` of its primary element, else of its
 * first element. Undefined sorts last.
 */
export function sortValue(resource: Json, path: ResolvedPath): unknown {
  const value = attributeValue(resource, path);
  if (path.attribute.multiValued) {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (path.attribute.type !== 'complex') return (value[0] as unknown) ?? undefined;
    const sub = path.subAttribute ?? findSubAttribute(path.attribute, 'value');
    const elements = value.filter(isObject);
    const chosen = elements.find((element) => element['primary'] === true) ?? elements[0];
    return sub === undefined || chosen === undefined ? undefined : (chosen[sub.name] ?? undefined);
  }
  if (path.subAttribute !== undefined)
    return isObject(value) ? (value[path.subAttribute.name] ?? undefined) : undefined;
  return value ?? undefined;
}

/** Orders two sort values of the given attribute type; undefined values sort last. */
export function compareSortValues(left: unknown, right: unknown, definition: AttributeDefinition): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  switch (definition.type) {
    case 'boolean':
      return Number(left) - Number(right);
    case 'integer':
    case 'decimal':
      return Number(left) - Number(right);
    case 'dateTime':
      return Date.parse(textOf(left)) - Date.parse(textOf(right));
    default: {
      let a = textOf(left);
      let b = textOf(right);
      if (!definition.caseExact) {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
      return a === b ? 0 : a < b ? -1 : 1;
    }
  }
}
