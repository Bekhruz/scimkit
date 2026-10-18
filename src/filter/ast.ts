import type { AttributeDefinition } from '../schema/definitions.js';

export type CompareOperator = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'lt' | 'ge' | 'le';

export const COMPARE_OPERATORS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'co',
  'sw',
  'ew',
  'gt',
  'lt',
  'ge',
  'le',
]);

export type FilterLiteral = string | number | boolean | null;

/** An attribute path as written: `[urn:]attribute[.subAttribute]`. */
export interface AttributePathSyntax {
  readonly uri?: string;
  readonly attribute: string;
  readonly subAttribute?: string;
}

/** A parsed filter, before its attribute paths are checked against a schema. */
export type FilterExpression =
  | {
      readonly type: 'compare';
      readonly path: AttributePathSyntax;
      readonly operator: CompareOperator;
      readonly value: FilterLiteral;
    }
  | { readonly type: 'present'; readonly path: AttributePathSyntax }
  | { readonly type: 'and' | 'or'; readonly left: FilterExpression; readonly right: FilterExpression }
  | { readonly type: 'not'; readonly expression: FilterExpression }
  | { readonly type: 'valuePath'; readonly path: AttributePathSyntax; readonly expression: FilterExpression };

/**
 * A resolved attribute reference. `attribute` is the top-level attribute,
 * `schema` the URN of the schema that defines it and `extension` whether its
 * value lives in an extension object. `subAttribute` is set for `name.givenName`
 * style paths. Inside a value filter (`emails[type eq "work"]`) paths are
 * relative to one element of the outer attribute: `attribute` is the outer
 * attribute and `subAttribute` the element's sub-attribute.
 */
export interface ResolvedPath {
  readonly schema: string;
  readonly extension: boolean;
  readonly attribute: AttributeDefinition;
  readonly subAttribute?: AttributeDefinition;
}

/** The value a comparison targets: the type that decides how values compare. */
export function targetDefinition(path: ResolvedPath): AttributeDefinition {
  return path.subAttribute ?? path.attribute;
}

/** Comparison literals after coercion to the attribute's type. */
export type ResolvedLiteral = string | number | boolean;

/**
 * A filter whose paths are resolved against a resource type and whose
 * literals are coerced to the attribute types. Repositories receive this form.
 * `and`/`or` are n-ary.
 */
export type ResolvedFilter =
  | {
      readonly type: 'compare';
      readonly path: ResolvedPath;
      readonly operator: CompareOperator;
      readonly value: ResolvedLiteral;
    }
  | { readonly type: 'present'; readonly path: ResolvedPath }
  | { readonly type: 'and' | 'or'; readonly filters: readonly ResolvedFilter[] }
  | { readonly type: 'not'; readonly filter: ResolvedFilter }
  | {
      readonly type: 'valuePath';
      readonly path: ResolvedPath;
      /** Paths in this filter are relative to one element of `path.attribute`. */
      readonly filter: ResolvedFilter;
    };
