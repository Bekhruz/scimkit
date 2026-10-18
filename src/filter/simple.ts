import type { ResolvedFilter, ResolvedLiteral, ResolvedPath } from './ast.js';
import { targetDefinition } from './ast.js';

/** One `attribute eq value` condition. */
export interface SimpleEquality {
  /** Canonical path: `userName`, `emails.value`, `members.value` or `urn:...:User:employeeNumber`. */
  readonly attribute: string;
  readonly value: ResolvedLiteral;
  /** Whether the attribute compares case-sensitively. */
  readonly caseExact: boolean;
}

function pathName(path: ResolvedPath): string {
  const base = path.extension ? `${path.schema}:${path.attribute.name}` : path.attribute.name;
  return path.subAttribute === undefined ? base : `${base}.${path.subAttribute.name}`;
}

/**
 * Recognises the filters provisioning clients actually send — one `eq`, or
 * several joined with `and`, including `members[value eq "<id>"]` — and
 * returns them as plain conditions. Returns undefined for anything else.
 * Custom repositories can map these to a WHERE clause and answer other
 * filters with `ScimError.invalidFilter`.
 *
 * @example
 * // id eq "g1" and members[value eq "u1"]
 * // → [{ attribute: 'id', value: 'g1' }, { attribute: 'members.value', value: 'u1' }]
 */
export function simpleEquality(filter: ResolvedFilter | undefined): SimpleEquality[] | undefined {
  if (filter === undefined) return [];
  switch (filter.type) {
    case 'compare':
      if (filter.operator !== 'eq') return undefined;
      return [
        {
          attribute: pathName(filter.path),
          value: filter.value,
          caseExact: targetDefinition(filter.path).caseExact,
        },
      ];
    case 'and': {
      const conditions: SimpleEquality[] = [];
      for (const inner of filter.filters) {
        const part = simpleEquality(inner);
        if (part === undefined) return undefined;
        conditions.push(...part);
      }
      return conditions;
    }
    case 'valuePath': {
      const inner = filter.filter;
      if (inner.type !== 'compare' || inner.operator !== 'eq') return undefined;
      return [
        {
          attribute: pathName(inner.path),
          value: inner.value,
          caseExact: targetDefinition(inner.path).caseExact,
        },
      ];
    }
    default:
      return undefined;
  }
}
