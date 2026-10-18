import {
  type CompareOperator,
  type ResolvedFilter,
  type ResolvedLiteral,
  type ResolvedPath,
  targetDefinition,
} from '../filter/ast.js';
import type { AttributeDefinition } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import type { TableNames } from './schema.js';

/**
 * A value an expression produces: a jsonb value from `data`, or a typed column.
 * `text` columns hold strings, `timestamp` columns timestamptz.
 */
type ValueRef =
  | { readonly kind: 'json'; readonly sql: string }
  | { readonly kind: 'text'; readonly sql: string }
  | { readonly kind: 'timestamp'; readonly sql: string };

/** A set of elements (rows) with sub-attribute values, for multi-valued attributes. */
interface ElementSource {
  /** `FROM ... WHERE ...` without the leading FROM; the WHERE correlates with the outer row. */
  readonly from: string;
  /** The value of a sub-attribute of one element, or of the element itself when `name` is undefined. */
  value(name: string | undefined): ValueRef;
  /** An ordering that puts the element to sort by first. */
  readonly sortOrder: string;
}

type Target =
  | { readonly kind: 'single'; readonly ref: ValueRef }
  | { readonly kind: 'multi'; readonly source: ElementSource; readonly sub: AttributeDefinition | undefined };

/** Collects bind parameters and fresh aliases while SQL is built. */
export class SqlBuilder {
  readonly params: unknown[] = [];
  private aliases = 0;

  constructor(
    readonly tables: TableNames,
    readonly type: CompiledResourceType,
    /** Alias of the resources table in the outer query. */
    readonly row = 'r',
  ) {}

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  alias(): string {
    this.aliases++;
    return `e${this.aliases}`;
  }
}

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

const arrayOf = (json: string): string =>
  `CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} ELSE '[]'::jsonb END`;

const COLUMN_TEXT = new Map([
  ['id', 'id'],
  ['externalId', 'external_id'],
  ['displayName', 'display_name'],
]);

/** The SQL boolean expression for a resolved filter. */
export function compileFilter(filter: ResolvedFilter, sql: SqlBuilder): string {
  switch (filter.type) {
    case 'and':
    case 'or':
      return `(${filter.filters.map((inner) => compileFilter(inner, sql)).join(filter.type === 'and' ? ' AND ' : ' OR ')})`;
    case 'not':
      return `NOT (${compileFilter(filter.filter, sql)})`;
    case 'present':
      return presentAt(target(filter.path, sql), sql);
    case 'compare':
      return compareAt(
        target(filter.path, sql),
        filter.operator,
        filter.value,
        targetDefinition(filter.path),
        sql,
      );
    case 'valuePath': {
      const source = elements(filter.path, sql);
      return `EXISTS (SELECT 1 FROM ${source.from} AND ${compileElement(filter.filter, source, sql)})`;
    }
  }
}

function compileElement(filter: ResolvedFilter, source: ElementSource, sql: SqlBuilder): string {
  switch (filter.type) {
    case 'and':
    case 'or':
      return `(${filter.filters.map((inner) => compileElement(inner, source, sql)).join(filter.type === 'and' ? ' AND ' : ' OR ')})`;
    case 'not':
      return `NOT (${compileElement(filter.filter, source, sql)})`;
    case 'present':
      return present(source.value(filter.path.subAttribute?.name));
    case 'compare': {
      const sub = filter.path.subAttribute as AttributeDefinition;
      const value = source.value(sub.name);
      if (!sub.multiValued || value.kind !== 'json')
        return compare(value, filter.operator, filter.value, sub, sql);
      // A multi-valued sub-attribute matches when any of its values does.
      const inner = jsonElements(value.sql, sql);
      return `EXISTS (SELECT 1 FROM ${inner.from} AND ${compare(inner.value(undefined), filter.operator, filter.value, sub, sql)})`;
    }
    /* v8 ignore next 2 -- the parser rejects nested value filters */
    case 'valuePath':
      return 'false';
  }
}

/** The JSON expression of the container of a path: `r.data` or `r.data -> '<extension urn>'`. */
function container(path: ResolvedPath, sql: SqlBuilder): string {
  return path.extension ? `${sql.row}.data -> ${quote(path.schema)}` : `${sql.row}.data`;
}

function target(path: ResolvedPath, sql: SqlBuilder): Target {
  const { attribute, subAttribute } = path;
  const r = sql.row;
  if (!path.extension) {
    if (attribute.name === 'meta') {
      switch (subAttribute?.name) {
        case 'created':
          return { kind: 'single', ref: { kind: 'timestamp', sql: `${r}.created_at` } };
        case 'lastModified':
          return { kind: 'single', ref: { kind: 'timestamp', sql: `${r}.updated_at` } };
        case 'resourceType':
          return { kind: 'single', ref: { kind: 'text', sql: `${r}.resource_type` } };
        default:
          return { kind: 'single', ref: { kind: 'json', sql: `NULL::jsonb` } };
      }
    }
    const column = COLUMN_TEXT.get(attribute.name);
    if (column !== undefined) return { kind: 'single', ref: { kind: 'text', sql: `${r}.${column}` } };
    if (attribute.name === 'userName' && sql.type.isUser) {
      return { kind: 'single', ref: { kind: 'text', sql: `${r}.user_name` } };
    }
    if (
      (attribute.name === 'members' && sql.type.isGroup) ||
      (attribute.name === 'groups' && sql.type.isUser)
    ) {
      return { kind: 'multi', source: elements(path, sql), sub: subAttribute };
    }
  }
  const json = `${container(path, sql)} -> ${quote(attribute.name)}`;
  if (attribute.multiValued) return { kind: 'multi', source: elements(path, sql), sub: subAttribute };
  if (subAttribute === undefined) return { kind: 'single', ref: { kind: 'json', sql: `(${json})` } };
  if (subAttribute.multiValued) {
    return {
      kind: 'multi',
      source: jsonElements(`(${json} -> ${quote(subAttribute.name)})`, sql),
      sub: undefined,
    };
  }
  return { kind: 'single', ref: { kind: 'json', sql: `(${json} -> ${quote(subAttribute.name)})` } };
}

/** The elements of a multi-valued (or, for value filters, complex) attribute. */
function elements(path: ResolvedPath, sql: SqlBuilder): ElementSource {
  const r = sql.row;
  const t = sql.tables;
  if (!path.extension && path.attribute.name === 'members' && sql.type.isGroup) {
    const m = sql.alias();
    return {
      from: `${t.members} AS ${m} JOIN ${t.resources} AS ${m}r ON ${m}r.tenant_id = ${m}.tenant_id AND ${m}r.id = ${m}.member_id WHERE ${m}.tenant_id = ${r}.tenant_id AND ${m}.group_id = ${r}.id`,
      value: (name) => {
        if (name === 'type') return { kind: 'text', sql: `${m}r.resource_type` };
        if (name === 'display') return { kind: 'text', sql: `coalesce(${m}r.display_name, ${m}r.user_name)` };
        return { kind: 'text', sql: `${m}.member_id` };
      },
      sortOrder: `${m}.seq`,
    };
  }
  if (!path.extension && path.attribute.name === 'groups' && sql.type.isUser) {
    const m = sql.alias();
    return {
      from: `${t.members} AS ${m} JOIN ${t.resources} AS ${m}g ON ${m}g.tenant_id = ${m}.tenant_id AND ${m}g.id = ${m}.group_id WHERE ${m}.tenant_id = ${r}.tenant_id AND ${m}.member_id = ${r}.id`,
      value: (name) => {
        if (name === 'display') return { kind: 'text', sql: `${m}g.display_name` };
        if (name === 'type') return { kind: 'text', sql: `'direct'::text` };
        return { kind: 'text', sql: `${m}g.id` };
      },
      sortOrder: `${m}g.seq`,
    };
  }
  const json = `(${container(path, sql)} -> ${quote(path.attribute.name)})`;
  if (!path.attribute.multiValued) {
    // A value filter on a single complex attribute: zero or one element.
    const e = sql.alias();
    return {
      from: `(SELECT ${json} AS v) AS ${e} WHERE jsonb_typeof(${e}.v) = 'object'`,
      value: (name) => ({ kind: 'json', sql: name === undefined ? `${e}.v` : `(${e}.v -> ${quote(name)})` }),
      sortOrder: '1',
    };
  }
  return jsonElements(json, sql);
}

function jsonElements(json: string, sql: SqlBuilder): ElementSource {
  const e = sql.alias();
  return {
    from: `jsonb_array_elements(${arrayOf(json)}) WITH ORDINALITY AS ${e}(v, i) WHERE true`,
    value: (name) => ({ kind: 'json', sql: name === undefined ? `${e}.v` : `(${e}.v -> ${quote(name)})` }),
    sortOrder: `COALESCE(${e}.v -> 'primary' = 'true'::jsonb, false) DESC, ${e}.i`,
  };
}

function presentAt(target: Target, sql: SqlBuilder): string {
  if (target.kind === 'single') return present(target.ref);
  const { source, sub } = target;
  if (sub?.multiValued === true) {
    const inner = jsonElements((source.value(sub.name) as { sql: string }).sql, sql);
    return `EXISTS (SELECT 1 FROM ${source.from} AND EXISTS (SELECT 1 FROM ${inner.from} AND ${present(inner.value(undefined))}))`;
  }
  return `EXISTS (SELECT 1 FROM ${source.from} AND ${present(source.value(sub?.name))})`;
}

function compareAt(
  target: Target,
  operator: CompareOperator,
  literal: ResolvedLiteral,
  definition: AttributeDefinition,
  sql: SqlBuilder,
): string {
  if (target.kind === 'single') return compare(target.ref, operator, literal, definition, sql);
  const { source, sub } = target;
  if (sub?.multiValued === true) {
    const inner = jsonElements((source.value(sub.name) as { sql: string }).sql, sql);
    return `EXISTS (SELECT 1 FROM ${source.from} AND EXISTS (SELECT 1 FROM ${inner.from} AND ${compare(inner.value(undefined), operator, literal, definition, sql)}))`;
  }
  return `EXISTS (SELECT 1 FROM ${source.from} AND ${compare(source.value(sub?.name), operator, literal, definition, sql)})`;
}

/** RFC 7644 "pr", matching `isPresent`: non-empty strings, arrays and objects. */
function present(ref: ValueRef): string {
  if (ref.kind === 'timestamp') return `(${ref.sql} IS NOT NULL)`;
  if (ref.kind === 'text') return `COALESCE(${ref.sql} <> '', false)`;
  const v = ref.sql;
  const scalar = (x: string) =>
    `(jsonb_typeof(${x}) NOT IN ('null', 'array', 'object') AND NOT (jsonb_typeof(${x}) = 'string' AND ${x} #>> '{}' = ''))`;
  const shallow = (x: string) =>
    `(${scalar(x)} OR (jsonb_typeof(${x}) = 'object' AND EXISTS (SELECT 1 FROM jsonb_each(${x}) AS p(k, w) WHERE ${scalar('p.w')})) OR (jsonb_typeof(${x}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${x}) AS q(w) WHERE ${scalar('q.w')})))`;
  return `COALESCE(${scalar(v)} OR (jsonb_typeof(${v}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${v}) AS a(x) WHERE ${shallow('a.x')})) OR (jsonb_typeof(${v}) = 'object' AND EXISTS (SELECT 1 FROM jsonb_each(${v}) AS o(k, x) WHERE ${shallow('o.x')})), false)`;
}

const ORDER_OPERATORS: Partial<Record<CompareOperator, string>> = { gt: '>', ge: '>=', lt: '<', le: '<=' };

/** The typed SQL of a value for comparisons and sorting. */
function typed(ref: ValueRef, definition: AttributeDefinition): string {
  if (ref.kind !== 'json') return ref.sql;
  switch (definition.type) {
    case 'boolean':
      return `(CASE WHEN jsonb_typeof(${ref.sql}) = 'boolean' THEN (${ref.sql})::boolean END)`;
    case 'integer':
    case 'decimal':
      return `(CASE WHEN jsonb_typeof(${ref.sql}) = 'number' THEN (${ref.sql})::numeric END)`;
    case 'dateTime':
      return `(CASE WHEN jsonb_typeof(${ref.sql}) = 'string' THEN (${ref.sql} #>> '{}')::timestamptz END)`;
    default:
      return `(${ref.sql} #>> '{}')`;
  }
}

function compare(
  ref: ValueRef,
  operator: CompareOperator,
  literal: ResolvedLiteral,
  definition: AttributeDefinition,
  sql: SqlBuilder,
): string {
  const value = typed(ref, definition);
  let condition: string;
  switch (definition.type) {
    case 'boolean':
      condition = `${value} ${operator === 'eq' ? '=' : 'IS DISTINCT FROM'} ${sql.param(literal)}::boolean`;
      break;
    case 'integer':
    case 'decimal':
    case 'dateTime': {
      const cast = definition.type === 'dateTime' ? 'timestamptz' : 'numeric';
      const parameter = `${sql.param(definition.type === 'dateTime' ? literal : String(literal))}::${cast}`;
      if (operator === 'eq') condition = `${value} = ${parameter}`;
      else if (operator === 'ne') condition = `${value} IS DISTINCT FROM ${parameter}`;
      else condition = `${value} ${ORDER_OPERATORS[operator] as string} ${parameter}`;
      break;
    }
    default: {
      const fold = (expression: string) => (definition.caseExact ? expression : `lower(${expression})`);
      const left = fold(value);
      const text = String(literal);
      switch (operator) {
        case 'eq':
          condition = `${left} = ${fold(`${sql.param(text)}::text`)}`;
          break;
        case 'ne':
          condition = `${left} IS DISTINCT FROM ${fold(`${sql.param(text)}::text`)}`;
          break;
        case 'co':
        case 'sw':
        case 'ew': {
          const escaped = fold(`${sql.param(text.replace(/[\\%_]/g, '\\$&'))}::text`);
          const pattern =
            operator === 'co'
              ? `'%' || ${escaped} || '%'`
              : operator === 'sw'
                ? `${escaped} || '%'`
                : `'%' || ${escaped}`;
          condition = `${left} LIKE ${pattern} ESCAPE '\\'`;
          break;
        }
        default:
          condition = `${left} COLLATE "C" ${ORDER_OPERATORS[operator] as string} ${fold(`${sql.param(text)}::text`)} COLLATE "C"`;
      }
    }
  }
  return `COALESCE(${condition}, false)`;
}

/**
 * The ORDER BY expression for sortBy: the attribute's typed value, or for a
 * multi-valued attribute the value of its primary (else first) element.
 */
export function compileSort(path: ResolvedPath, sql: SqlBuilder): string {
  const definition = targetDefinition(path);
  const fold = (expression: string) =>
    ['string', 'reference', 'binary'].includes(definition.type)
      ? `${definition.caseExact ? expression : `lower(${expression})`} COLLATE "C"`
      : expression;
  const where = target(path, sql);
  if (where.kind === 'single') return fold(typed(where.ref, definition));
  const { source, sub } = where;
  return `(SELECT ${fold(typed(source.value(sub?.name), definition))} FROM ${source.from} ORDER BY ${source.sortOrder} LIMIT 1)`;
}
