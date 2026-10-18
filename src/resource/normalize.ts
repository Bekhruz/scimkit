import { ScimError } from '../errors.js';
import { isDateTime } from '../filter/resolve.js';
import { type AttributeDefinition, findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import { deepEqual, isObject, type JsonObject, UNSAFE_KEYS } from './json.js';

export interface NormalizeOptions {
  lenient: boolean;
  /** Called with the path of each attribute dropped because the schema does not define it. */
  onUnknownAttribute?: (path: string) => void;
}

export interface NormalizedAttributes {
  /** Canonical attribute data: schema-cased names, extension objects keyed by their URN. */
  attributes: JsonObject;
  /** The clear-text password, when the input set one. Never stored with the attributes. */
  password?: string;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/**
 * Validates and canonicalises a resource from a POST or PUT body: checks
 * `schemas`, coerces values to the attribute types, drops read-only and
 * unknown attributes (or rejects unknown ones in strict mode), and enforces
 * required, immutable and primary rules.
 */
export function normalizeResourceBody(
  body: unknown,
  type: CompiledResourceType,
  options: NormalizeOptions & { existing?: JsonObject },
): NormalizedAttributes {
  if (!isObject(body)) throw ScimError.invalidSyntax('The request body must be a JSON object.');
  const schemas = body['schemas'];
  if (schemas === undefined || schemas === null) {
    if (!options.lenient) throw ScimError.invalidSyntax('The "schemas" attribute is required.');
  } else {
    if (!Array.isArray(schemas) || !schemas.every((urn) => typeof urn === 'string')) {
      throw ScimError.invalidSyntax('"schemas" must be an array of schema URNs.');
    }
    const declared = new Set(schemas.map((urn) => urn.toLowerCase()));
    if (!options.lenient) {
      if (!declared.has(type.coreUrn.toLowerCase())) {
        throw ScimError.invalidSyntax(`"schemas" must include ${type.coreUrn}.`);
      }
      for (const urn of schemas) {
        if (urn.toLowerCase() !== type.coreUrn.toLowerCase() && type.extension(urn) === undefined) {
          throw ScimError.invalidValue(`Schema ${urn} is not supported by ${type.name} resources.`);
        }
      }
    }
  }
  const attributes: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'schemas') continue;
    attributes[key] = value;
  }
  return normalizeAttributes(attributes, type, options);
}

/**
 * Validates and canonicalises attribute data (a resource without `schemas`).
 * With `existing`, immutable attributes that already have a value must keep
 * it; omitted immutable values are carried over.
 */
export function normalizeAttributes(
  input: JsonObject,
  type: CompiledResourceType,
  options: NormalizeOptions & { existing?: JsonObject },
): NormalizedAttributes {
  const result: NormalizedAttributes = { attributes: {} };
  const unknown = (path: string): void => {
    if (!options.lenient) throw ScimError.invalidValue(`Unknown attribute "${path}".`);
    options.onUnknownAttribute?.(path);
  };

  for (const [key, value] of Object.entries(input)) {
    if (UNSAFE_KEYS.has(key)) {
      unknown(key);
      continue;
    }
    const extension = type.extension(key);
    if (extension !== undefined) {
      if (value === null || value === undefined) continue;
      if (!isObject(value)) throw ScimError.invalidValue(`"${extension.schema.id}" must be an object.`);
      const target = (result.attributes[extension.schema.id] ?? {}) as JsonObject;
      for (const [name, inner] of Object.entries(value)) {
        const located = type.attributeIn(extension.schema.id, name);
        if (located === undefined || UNSAFE_KEYS.has(name)) {
          unknown(`${extension.schema.id}:${name}`);
          continue;
        }
        assign(
          target,
          located.definition,
          inner,
          `${extension.schema.id}:${located.definition.name}`,
          options,
        );
      }
      if (Object.keys(target).length > 0) result.attributes[extension.schema.id] = target;
      continue;
    }
    let located = type.attributeIn(type.coreUrn, key);
    if (located === undefined && options.lenient) {
      // Flattened, URN-qualified keys: {"urn:...:enterprise:2.0:User:department": "R&D"}.
      const split = type.splitUrn(key);
      if (split !== undefined && split.rest !== '' && !split.rest.includes('.')) {
        located = type.attributeIn(split.urn, split.rest);
      }
    }
    if (located === undefined) {
      unknown(key);
      continue;
    }
    const definition = located.definition;
    if (definition.mutability === 'readOnly') continue;
    if (type.isUser && definition.name === 'password' && !located.extension) {
      const password = normalizeValue(definition, value, 'password', options);
      if (typeof password === 'string') result.password = password;
      continue;
    }
    let target = result.attributes;
    if (located.extension) {
      target = (result.attributes[located.schema] ?? {}) as JsonObject;
      result.attributes[located.schema] = target;
    }
    assign(target, definition, value, definition.name, options);
    if (located.extension && Object.keys(target).length === 0)
      Reflect.deleteProperty(result.attributes, located.schema);
  }

  if (options.existing !== undefined) carryImmutable(result.attributes, options.existing, type);
  assertRequired(result.attributes, type);
  return result;
}

function assign(
  target: JsonObject,
  definition: AttributeDefinition,
  value: unknown,
  label: string,
  options: NormalizeOptions,
): void {
  if (definition.mutability === 'readOnly') return;
  const normalized = normalizeValue(definition, value, label, options);
  if (normalized === undefined) Reflect.deleteProperty(target, definition.name);
  else target[definition.name] = normalized;
}

/**
 * Coerces one attribute value to its definition. Returns undefined for
 * unassigned values: null, empty arrays and complex values without content.
 */
export function normalizeValue(
  definition: AttributeDefinition,
  value: unknown,
  label: string,
  options: NormalizeOptions,
): unknown {
  if (value === null || value === undefined) return undefined;
  if (!definition.multiValued) return normalizeSingle(definition, value, label, options);
  let values: unknown[];
  if (Array.isArray(value)) values = value;
  else if (options.lenient) values = [value];
  else throw ScimError.invalidValue(`"${label}" is multi-valued and must be an array.`);
  const normalized = values
    .map((item) => normalizeSingle(definition, item, label, options))
    .filter((item) => item !== undefined);
  if (definition.type === 'complex') enforceSinglePrimary(normalized as JsonObject[], label, options);
  return normalized.length === 0 ? undefined : normalized;
}

/** Coerces one element of a multi-valued attribute (or a single-valued attribute's value). */
export function normalizeElement(
  definition: AttributeDefinition,
  value: unknown,
  label: string,
  options: NormalizeOptions,
): unknown {
  return normalizeSingle(definition, value, label, options);
}

function normalizeSingle(
  definition: AttributeDefinition,
  value: unknown,
  label: string,
  options: NormalizeOptions,
): unknown {
  if (value === null || value === undefined) return undefined;
  const invalid = (expected: string): never => {
    throw ScimError.invalidValue(`"${label}" must be ${expected}.`);
  };
  switch (definition.type) {
    case 'complex': {
      let object = value;
      if (!isObject(object)) {
        // {"op":"add","path":"...:manager","value":"<id>"} sends the value sub-attribute alone.
        const valueSub = findSubAttribute(definition, 'value');
        if (
          options.lenient &&
          valueSub !== undefined &&
          (typeof value === 'string' || typeof value === 'number')
        ) {
          object = { [valueSub.name]: value };
        } else {
          return invalid('an object');
        }
      }
      const result: JsonObject = {};
      for (const [key, inner] of Object.entries(object as JsonObject)) {
        const sub = findSubAttribute(definition, key);
        if (sub === undefined || UNSAFE_KEYS.has(key)) {
          if (!options.lenient) throw ScimError.invalidValue(`Unknown attribute "${label}.${key}".`);
          options.onUnknownAttribute?.(`${label}.${key}`);
          continue;
        }
        if (sub.mutability === 'readOnly' || isServerReference(sub)) continue;
        const normalized = normalizeValue(sub, inner, `${label}.${sub.name}`, options);
        if (normalized !== undefined) result[sub.name] = normalized;
      }
      for (const sub of definition.subAttributes ?? []) {
        if (sub.required && sub.mutability !== 'readOnly' && result[sub.name] === undefined) {
          throw ScimError.invalidValue(`"${label}.${sub.name}" is required.`);
        }
      }
      return Object.keys(result).length === 0 ? undefined : result;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (options.lenient && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
        return value.trim().toLowerCase() === 'true';
      }
      return invalid('true or false');
    case 'integer': {
      const number = toNumber(value, options);
      if (number === undefined || !Number.isInteger(number)) return invalid('an integer');
      return number;
    }
    case 'decimal': {
      const number = toNumber(value, options);
      if (number === undefined) return invalid('a number');
      return number;
    }
    case 'dateTime':
      if (typeof value === 'string' && isDateTime(value)) return value;
      return invalid('an xsd:dateTime string such as "2024-05-01T12:00:00Z"');
    case 'binary':
      if (typeof value === 'string' && (BASE64.test(value) || (options.lenient && BASE64URL.test(value)))) {
        return value;
      }
      return invalid('base64-encoded');
    default:
      if (typeof value === 'string') {
        if (value.includes('\u0000')) return invalid('a string without null characters');
        return value;
      }
      if (options.lenient && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
      return invalid('a string');
  }
}

function toNumber(value: unknown, options: NormalizeOptions): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (options.lenient && typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

/**
 * `$ref` sub-attributes that point at SCIM resources are computed by the
 * server from `value` (and `type`) on every response, so they are not stored.
 */
export function isServerReference(definition: AttributeDefinition): boolean {
  return (
    definition.name === '$ref' &&
    !(definition.referenceTypes ?? []).some((kind) => kind === 'external' || kind === 'uri')
  );
}

function enforceSinglePrimary(elements: JsonObject[], label: string, options: NormalizeOptions): void {
  const primaries = elements.filter((element) => element['primary'] === true);
  if (primaries.length <= 1) return;
  if (!options.lenient) throw ScimError.invalidValue(`Only one value of "${label}" can be primary.`);
  for (const element of primaries.slice(1)) element['primary'] = false;
}

function carryImmutable(attributes: JsonObject, existing: JsonObject, type: CompiledResourceType): void {
  const check = (target: JsonObject, before: JsonObject, definition: AttributeDefinition, label: string) => {
    const previous = before[definition.name];
    if (previous === undefined) return;
    if (definition.mutability === 'immutable') {
      const next = target[definition.name];
      if (next === undefined) target[definition.name] = previous;
      else if (!deepEqual(next, previous)) throw ScimError.mutability(`"${label}" is immutable.`);
      return;
    }
    if (definition.type === 'complex' && !definition.multiValued && isObject(previous)) {
      const subs = definition.subAttributes ?? [];
      if (!subs.some((sub) => sub.mutability === 'immutable')) return;
      const next = isObject(target[definition.name]) ? (target[definition.name] as JsonObject) : {};
      for (const sub of subs) check(next, previous, sub, `${label}.${sub.name}`);
      if (Object.keys(next).length > 0) target[definition.name] = next;
    }
  };
  for (const definition of type.definition.schema.attributes)
    check(attributes, existing, definition, definition.name);
  for (const extension of type.extensions) {
    const before = existing[extension.schema.id];
    if (!isObject(before)) continue;
    const target = isObject(attributes[extension.schema.id])
      ? (attributes[extension.schema.id] as JsonObject)
      : {};
    for (const definition of extension.schema.attributes) {
      check(target, before, definition, `${extension.schema.id}:${definition.name}`);
    }
    if (Object.keys(target).length > 0) attributes[extension.schema.id] = target;
  }
}

function assertRequired(attributes: JsonObject, type: CompiledResourceType): void {
  for (const definition of type.definition.schema.attributes) {
    if (
      definition.required &&
      definition.mutability !== 'readOnly' &&
      attributes[definition.name] === undefined
    ) {
      if (type.isUser && definition.name === 'password') continue;
      throw ScimError.invalidValue(`"${definition.name}" is required.`);
    }
  }
  for (const extension of type.extensions) {
    const object = attributes[extension.schema.id];
    if (object === undefined) {
      if (extension.required)
        throw ScimError.invalidValue(`The ${extension.schema.id} extension is required.`);
      continue;
    }
    for (const definition of extension.schema.attributes) {
      if (
        definition.required &&
        definition.mutability !== 'readOnly' &&
        (object as JsonObject)[definition.name] === undefined
      ) {
        throw ScimError.invalidValue(`"${extension.schema.id}:${definition.name}" is required.`);
      }
    }
  }
}
