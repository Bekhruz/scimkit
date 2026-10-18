import { type AttributeDefinition, findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import { isObject, type JsonObject } from './json.js';
import { isServerReference } from './normalize.js';

export interface ScimMeta {
  resourceType: string;
  created: string;
  lastModified: string;
  location: string;
  version: string;
}

/** A resource as SCIM clients see it. */
export interface ScimResource extends JsonObject {
  schemas: string[];
  id: string;
  meta: ScimMeta;
}

/** A resource as repositories store and return it. */
export interface StoredResource {
  id: string;
  /** An opaque version token. The ETag is `W/"<version>"`; it must not contain `"`. */
  version: string;
  created: Date;
  lastModified: Date;
  /**
   * Canonical attribute data, including `externalId` and extension objects
   * keyed by URN; never `id`, `meta` or `schemas`. Repositories add computed
   * read-only values here, such as a User's `groups` and a member's `display`.
   */
  attributes: JsonObject;
}

/** Turns resource type names into URLs for `$ref` values and `meta.location`. */
export interface ReferenceResolver {
  readonly baseUrl: string;
  endpointOf(resourceTypeName: string): string | undefined;
}

export function etagOf(version: string): string {
  return `W/"${version}"`;
}

export function locationOf(baseUrl: string, endpoint: string, id: string): string {
  return `${baseUrl}${endpoint}/${encodeURIComponent(id)}`;
}

/** Builds the SCIM representation of a stored resource, in a stable key order. */
export function toScimResource(
  stored: StoredResource,
  type: CompiledResourceType,
  references: ReferenceResolver,
): ScimResource {
  const source = stored.attributes;
  const resource: JsonObject = { schemas: [type.coreUrn], id: stored.id };
  if (typeof source['externalId'] === 'string') resource['externalId'] = source['externalId'];
  for (const definition of type.definition.schema.attributes) {
    const value = render(definition, source[definition.name], type, references);
    if (value !== undefined) resource[definition.name] = value;
  }
  const schemas = [type.coreUrn];
  for (const extension of type.extensions) {
    const object = source[extension.schema.id];
    if (!isObject(object)) continue;
    const rendered: JsonObject = {};
    for (const definition of extension.schema.attributes) {
      const value = render(definition, object[definition.name], type, references);
      if (value !== undefined) rendered[definition.name] = value;
    }
    if (Object.keys(rendered).length > 0) {
      resource[extension.schema.id] = rendered;
      schemas.push(extension.schema.id);
    }
  }
  resource['schemas'] = schemas;
  resource['meta'] = {
    resourceType: type.name,
    created: stored.created.toISOString(),
    lastModified: stored.lastModified.toISOString(),
    location: locationOf(references.baseUrl, type.endpoint, stored.id),
    version: etagOf(stored.version),
  } satisfies ScimMeta;
  return resource as ScimResource;
}

function render(
  definition: AttributeDefinition,
  value: unknown,
  type: CompiledResourceType,
  references: ReferenceResolver,
): unknown {
  if (value === undefined || value === null) return undefined;
  if (definition.returned === 'never') return undefined;
  if (definition.type !== 'complex') return value;
  const reference = definition.subAttributes?.find(isServerReference);
  const renderElement = (element: unknown): unknown => {
    if (!isObject(element)) return element;
    const out: JsonObject = {};
    for (const sub of definition.subAttributes ?? []) {
      if (sub === reference || sub.returned === 'never') continue;
      const inner = element[sub.name];
      if (inner !== undefined && inner !== null) out[sub.name] = inner;
    }
    if (reference !== undefined && typeof element['value'] === 'string') {
      const target = referenceTarget(definition, reference, element, type, references);
      const endpoint = target === undefined ? undefined : references.endpointOf(target);
      if (endpoint !== undefined)
        out[reference.name] = locationOf(references.baseUrl, endpoint, element['value']);
    }
    return out;
  };
  if (definition.multiValued) return Array.isArray(value) ? value.map(renderElement) : undefined;
  return renderElement(value);
}

/**
 * Which resource type a reference points at: the element's `type` when it
 * names one of the attribute's reference types, the Group type for a User's
 * `groups`, otherwise the first reference type that the server serves.
 */
function referenceTarget(
  definition: AttributeDefinition,
  reference: AttributeDefinition,
  element: JsonObject,
  type: CompiledResourceType,
  references: ReferenceResolver,
): string | undefined {
  const candidates = (reference.referenceTypes ?? []).filter(
    (name) => references.endpointOf(name) !== undefined,
  );
  const declared = typeof element['type'] === 'string' ? element['type'].toLowerCase() : undefined;
  const typed = candidates.find((name) => name.toLowerCase() === declared);
  if (typed !== undefined) return typed;
  if (type.isUser && definition.name === 'groups' && findSubAttribute(definition, 'value') !== undefined) {
    return candidates.find((name) => name === 'Group');
  }
  return candidates[0];
}
