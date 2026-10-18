import { ScimError } from '../errors.js';
import { parseAttributePath } from '../filter/parser.js';
import { resolveAttributePath } from '../filter/resolve.js';
import type { AttributeDefinition } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import { isObject, type JsonObject } from './json.js';
import type { ScimResource } from './representation.js';

/** One entry of an `attributes` or `excludedAttributes` list. */
export type AttributeSelection =
  | {
      readonly kind: 'attribute';
      readonly schema: string;
      readonly attribute: AttributeDefinition;
      readonly subAttribute?: AttributeDefinition;
    }
  | { readonly kind: 'schema'; readonly schema: string };

/** The attribute selection of a request (RFC 7644 §3.9). */
export interface Projection {
  readonly attributes?: readonly AttributeSelection[];
  readonly excludedAttributes?: readonly AttributeSelection[];
}

/**
 * Parses `attributes` / `excludedAttributes` entries for a resource type.
 * Unknown attributes are ignored in lenient mode and rejected otherwise.
 */
export function parseAttributeSelection(
  entries: readonly string[],
  type: CompiledResourceType,
  options: { lenient: boolean },
): AttributeSelection[] {
  const selections: AttributeSelection[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const split = type.splitUrn(entry);
    if (split?.rest === '') {
      selections.push({ kind: 'schema', schema: split.urn });
      continue;
    }
    try {
      const path = resolveAttributePath(
        parseAttributePath(entry, ScimError.invalidValue),
        type,
        options,
        ScimError.invalidValue,
      );
      selections.push({
        kind: 'attribute',
        schema: path.schema,
        attribute: path.attribute,
        ...(path.subAttribute === undefined ? {} : { subAttribute: path.subAttribute }),
      });
    } catch (error) {
      if (!options.lenient) throw error;
    }
  }
  return selections;
}

/** Whether a projection leaves out an attribute entirely, so a repository can skip loading it. */
export function excludes(projection: Projection, schema: string, name: string): boolean {
  const lower = name.toLowerCase();
  const matches = (selection: AttributeSelection): boolean =>
    selection.kind === 'schema'
      ? selection.schema === schema
      : selection.schema === schema && selection.attribute.name.toLowerCase() === lower;
  if (projection.attributes !== undefined && projection.attributes.length > 0) {
    return !projection.attributes.some(matches);
  }
  return (projection.excludedAttributes ?? []).some(
    (selection) =>
      matches(selection) && (selection.kind === 'schema' || selection.subAttribute === undefined),
  );
}

/** Applies a projection to a resource representation. */
export function projectResource(
  resource: ScimResource,
  type: CompiledResourceType,
  projection: Projection,
): ScimResource {
  const include =
    projection.attributes !== undefined && projection.attributes.length > 0
      ? projection.attributes
      : undefined;
  const exclude = include === undefined ? (projection.excludedAttributes ?? []) : [];
  const out: JsonObject = { schemas: [], id: resource.id };
  const schemas = [type.coreUrn];

  for (const [key, value] of Object.entries(resource)) {
    if (key === 'schemas' || key === 'id') continue;
    const extension = type.extension(key);
    if (extension !== undefined) {
      if (!isObject(value)) continue;
      const projected: JsonObject = {};
      for (const [name, inner] of Object.entries(value)) {
        const definition = type.attributeIn(extension.schema.id, name)?.definition;
        if (definition === undefined) continue;
        const kept = decide(definition, extension.schema.id, inner, include, exclude);
        if (kept !== undefined) projected[name] = kept;
      }
      if (Object.keys(projected).length > 0) {
        out[key] = projected;
        schemas.push(extension.schema.id);
      }
      continue;
    }
    const definition = type.coreAttribute(key);
    if (definition === undefined) continue;
    const kept = decide(definition, type.coreUrn, value, include, exclude);
    if (kept !== undefined) out[key] = kept;
  }
  out['schemas'] = schemas;
  return out as ScimResource;
}

function decide(
  definition: AttributeDefinition,
  schema: string,
  value: unknown,
  include: readonly AttributeSelection[] | undefined,
  exclude: readonly AttributeSelection[],
): unknown {
  if (definition.returned === 'never') return undefined;
  if (definition.returned === 'always') return value;
  const relevant = (selections: readonly AttributeSelection[]) =>
    selections.filter((selection) =>
      selection.kind === 'schema'
        ? selection.schema === schema
        : selection.schema === schema && selection.attribute === definition,
    );

  if (include !== undefined) {
    const selected = relevant(include);
    if (selected.length === 0) return undefined;
    const whole = selected.some(
      (selection) => selection.kind === 'schema' || selection.subAttribute === undefined,
    );
    if (whole) return value;
    const names = new Set(
      selected.flatMap((selection) =>
        selection.kind === 'attribute' && selection.subAttribute !== undefined
          ? [selection.subAttribute.name]
          : [],
      ),
    );
    return pickSubAttributes(definition, value, (sub) => names.has(sub.name) || sub.returned === 'always');
  }

  if (definition.returned === 'request') return undefined;
  const excluded = relevant(exclude);
  if (excluded.some((selection) => selection.kind === 'schema' || selection.subAttribute === undefined)) {
    return undefined;
  }
  const names = new Set(
    excluded.flatMap((selection) =>
      selection.kind === 'attribute' && selection.subAttribute !== undefined
        ? [selection.subAttribute.name]
        : [],
    ),
  );
  if (names.size === 0) {
    return definition.type === 'complex'
      ? pickSubAttributes(definition, value, (sub) => sub.returned !== 'request')
      : value;
  }
  return pickSubAttributes(
    definition,
    value,
    (sub) => sub.returned === 'always' || (!names.has(sub.name) && sub.returned !== 'request'),
  );
}

function pickSubAttributes(
  definition: AttributeDefinition,
  value: unknown,
  keep: (sub: AttributeDefinition) => boolean,
): unknown {
  if (definition.type !== 'complex') return value;
  const kept = new Set((definition.subAttributes ?? []).filter(keep).map((sub) => sub.name));
  const pick = (element: unknown): JsonObject | undefined => {
    if (!isObject(element)) return undefined;
    const out: JsonObject = {};
    for (const [key, inner] of Object.entries(element)) if (kept.has(key)) out[key] = inner;
    return Object.keys(out).length === 0 ? undefined : out;
  };
  if (definition.multiValued) {
    if (!Array.isArray(value)) return undefined;
    const elements = value.map(pick).filter((element) => element !== undefined);
    return elements.length === 0 ? undefined : elements;
  }
  return pick(value);
}
