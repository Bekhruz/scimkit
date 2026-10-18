import { isObject, type JsonObject } from '../resource/json.js';
import type { AttributeDefinition } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';

/** A single-valued attribute whose values must be unique (`uniqueness: "server"` or `"global"`). */
export interface UniqueAttribute {
  readonly schema: string;
  readonly extension: boolean;
  readonly definition: AttributeDefinition;
  /** The attribute as clients name it, for error messages. */
  readonly label: string;
}

/**
 * The attributes a store must keep unique. `id` is excluded: stores generate
 * it. Multi-valued and complex attributes cannot carry a uniqueness constraint
 * that a store could enforce, so they are excluded as well.
 */
export function uniqueAttributes(type: CompiledResourceType): UniqueAttribute[] {
  const result: UniqueAttribute[] = [];
  const consider = (schema: string, extension: boolean, definition: AttributeDefinition) => {
    if (definition.uniqueness === 'none' || definition.multiValued || definition.type === 'complex') return;
    result.push({
      schema,
      extension,
      definition,
      label: extension ? `${schema}:${definition.name}` : definition.name,
    });
  };
  for (const definition of type.definition.schema.attributes) consider(type.coreUrn, false, definition);
  for (const extension of type.extensions) {
    for (const definition of extension.schema.attributes) consider(extension.schema.id, true, definition);
  }
  return result;
}

/** The value to compare for uniqueness: strings of case-insensitive attributes are lowercased. */
export function uniqueValue(
  attributes: JsonObject,
  unique: UniqueAttribute,
): string | number | boolean | undefined {
  const container = unique.extension ? attributes[unique.schema] : attributes;
  if (!isObject(container)) return undefined;
  const value = container[unique.definition.name];
  if (typeof value === 'string') return unique.definition.caseExact ? value : value.toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}
