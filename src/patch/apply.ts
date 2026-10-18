import { SCIM_MESSAGES } from '../constants.js';
import { isScimError, ScimError } from '../errors.js';
import type { ResolvedFilter } from '../filter/ast.js';
import { compareValue, evaluateElement, isPresent } from '../filter/evaluate.js';
import { normalizeElement, normalizeValue, type NormalizeOptions } from '../resource/normalize.js';
import { cloneJson, deepEqual, isObject, type JsonObject } from '../resource/json.js';
import { type AttributeDefinition, findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';
import { parsePatchPath, type PatchTarget } from './path.js';

export type PatchOperationName = 'add' | 'remove' | 'replace';

/** One operation of a PATCH request, after syntax checks. */
export interface PatchOperation {
  readonly op: PatchOperationName;
  readonly path?: string;
  readonly value?: unknown;
}

const OPERATIONS = new Set(['add', 'remove', 'replace']);

function field(object: JsonObject, name: string, lenient: boolean): unknown {
  if (name in object || !lenient) return object[name];
  const lower = name.toLowerCase();
  const key = Object.keys(object).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : object[key];
}

function hasField(object: JsonObject, name: string, lenient: boolean): boolean {
  if (name in object) return true;
  return lenient && Object.keys(object).some((key) => key.toLowerCase() === name.toLowerCase());
}

/**
 * Checks the envelope of a PATCH request (RFC 7644 §3.5.2) and returns its
 * operations. Operation names are accepted in any case ("Replace" is what
 * Microsoft Entra ID sends).
 */
export function parsePatchBody(
  body: unknown,
  options: { lenient: boolean; maxOperations: number },
): PatchOperation[] {
  if (!isObject(body)) throw ScimError.invalidSyntax('The request body must be a JSON object.');
  const schemas = body['schemas'];
  if (!options.lenient && (!Array.isArray(schemas) || !schemas.includes(SCIM_MESSAGES.patchOp))) {
    throw ScimError.invalidSyntax(`"schemas" must include ${SCIM_MESSAGES.patchOp}.`);
  }
  const operations = field(body, 'Operations', options.lenient);
  if (!Array.isArray(operations) || operations.length === 0) {
    throw ScimError.invalidSyntax('"Operations" must be a non-empty array.');
  }
  if (operations.length > options.maxOperations) {
    throw ScimError.payloadTooLarge(`A PATCH request can have at most ${options.maxOperations} operations.`);
  }
  return operations.map((operation, index) => {
    const position = `Operation ${index + 1}`;
    if (!isObject(operation)) throw ScimError.invalidSyntax(`${position} must be an object.`);
    const op = field(operation, 'op', options.lenient);
    if (typeof op !== 'string' || !OPERATIONS.has(op.toLowerCase())) {
      throw ScimError.invalidSyntax(`${position} has an unknown "op"; use add, remove or replace.`);
    }
    const name = op.toLowerCase() as PatchOperationName;
    const path = field(operation, 'path', options.lenient);
    if (path !== undefined && path !== null && typeof path !== 'string') {
      throw ScimError.invalidPath(`${position} has a "path" that is not a string.`);
    }
    if (name !== 'remove' && !hasField(operation, 'value', options.lenient)) {
      throw ScimError.invalidSyntax(`${position} (${name}) needs a "value".`);
    }
    const value = field(operation, 'value', options.lenient);
    return {
      op: name,
      ...(typeof path === 'string' && path.trim() !== '' ? { path } : {}),
      ...(value === undefined ? {} : { value }),
    };
  });
}

export interface ApplyPatchOptions extends NormalizeOptions {
  /** The id of the patched resource, so that `{"id": "<same id>"}` in a value is accepted. */
  resourceId: string;
}

/**
 * Applies PATCH operations to a copy of a resource's attributes and returns
 * the result. Operations apply in order and the request fails as a whole.
 * The result still needs {@link normalizeAttributes} to check required and
 * immutable attributes.
 *
 * Compatibility (lenient mode) on top of RFC 7644:
 * - a value filter that matches nothing on add/replace creates the element
 *   from the filter's `eq` conditions (`emails[type eq "work"].value`);
 * - read-only attributes inside a path-less value are ignored;
 * - unknown attributes inside a path-less value are ignored.
 * In both modes, `remove` with a value removes only the listed values of a
 * multi-valued attribute, which is how Microsoft Entra ID removes members.
 */
export function applyPatch(
  attributes: JsonObject,
  operations: readonly PatchOperation[],
  type: CompiledResourceType,
  options: ApplyPatchOptions,
): JsonObject {
  const data = cloneJson(attributes);
  for (const operation of operations) applyOperation(data, operation, type, options);
  return data;
}

function applyOperation(
  data: JsonObject,
  operation: PatchOperation,
  type: CompiledResourceType,
  options: ApplyPatchOptions,
): void {
  if (operation.path === undefined) {
    if (operation.op === 'remove') throw ScimError.noTarget('A remove operation needs a "path".');
    if (!isObject(operation.value)) {
      throw ScimError.invalidValue('Without a "path", the "value" must be an object of attributes.');
    }
    applyObject(data, operation.op, operation.value, undefined, type, options);
    return;
  }
  const target = parsePatchPath(operation.path, type, options);
  applyTarget(data, operation.op, target, operation.value, 'path', type, options);
}

/** A path-less add/replace (or one on a whole extension): every key is a target. */
function applyObject(
  data: JsonObject,
  op: PatchOperationName,
  value: JsonObject,
  schema: string | undefined,
  type: CompiledResourceType,
  options: ApplyPatchOptions,
): void {
  for (const [key, inner] of Object.entries(value)) {
    if (schema === undefined && key === 'schemas') continue;
    let target: PatchTarget;
    try {
      target = parsePatchPath(schema === undefined ? key : `${schema}:${key}`, type, options);
    } catch (error) {
      if (options.lenient && isScimError(error)) {
        options.onUnknownAttribute?.(key);
        continue;
      }
      throw error;
    }
    if (schema !== undefined && target.kind === 'extension') continue;
    applyTarget(data, op, target, inner, 'value', type, options);
  }
}

function applyTarget(
  data: JsonObject,
  op: PatchOperationName,
  target: PatchTarget,
  value: unknown,
  origin: 'path' | 'value',
  type: CompiledResourceType,
  options: ApplyPatchOptions,
): void {
  if (target.kind === 'extension') {
    if (op === 'remove' || (op === 'replace' && (value === null || value === undefined))) {
      Reflect.deleteProperty(data, target.schema);
      return;
    }
    if (value === null || value === undefined) return;
    if (!isObject(value)) throw ScimError.invalidValue(`The value for "${target.schema}" must be an object.`);
    applyObject(data, op, value, target.schema, type, options);
    return;
  }

  const { path, filter } = target;
  const attribute = path.attribute;
  const sub = path.subAttribute;

  if (attribute.mutability === 'readOnly' || sub?.mutability === 'readOnly') {
    if (attribute.name === 'id' && !path.extension && value === options.resourceId) return;
    if (origin === 'value' && options.lenient) return;
    throw ScimError.mutability(`"${target.text}" is read-only.`);
  }

  const container = containerOf(data, path.extension ? path.schema : undefined, op !== 'remove');
  if (container === undefined) return;
  const label = target.text;

  if (filter !== undefined) {
    applyFiltered(container, op, attribute, sub, filter, value, label, options);
  } else if (sub === undefined) {
    applyWhole(container, op, attribute, value, label, options);
  } else if (!attribute.multiValued) {
    const object = isObject(container[attribute.name])
      ? { ...(container[attribute.name] as JsonObject) }
      : {};
    assertMutable(sub, object[sub.name], op, value, label, options);
    setOrDelete(object, sub, op === 'remove' ? undefined : normalizeValue(sub, value, label, options));
    write(container, attribute, Object.keys(object).length === 0 ? undefined : object);
  } else {
    applyUnfilteredSub(container, op, attribute, sub, value, label, options);
  }

  if (path.extension && Object.keys(container).length === 0) {
    Reflect.deleteProperty(data, path.schema);
  }
}

function applyWhole(
  container: JsonObject,
  op: PatchOperationName,
  attribute: AttributeDefinition,
  value: unknown,
  label: string,
  options: ApplyPatchOptions,
): void {
  const current = container[attribute.name];
  assertMutable(attribute, current, op, value, label, options);
  if (op === 'remove') {
    if (attribute.multiValued && value !== undefined && value !== null && Array.isArray(current)) {
      const listed = (normalizeValue(attribute, value, label, options) ?? []) as unknown[];
      write(
        container,
        attribute,
        current.filter((element) => !listed.some((item) => sameElement(element, item, attribute))),
      );
    } else {
      write(container, attribute, undefined);
    }
    return;
  }
  const next = normalizeValue(attribute, value, label, options);
  if (attribute.multiValued) {
    if (op === 'replace') write(container, attribute, next);
    else if (next !== undefined)
      write(container, attribute, mergeElements(current, next as unknown[], attribute));
    return;
  }
  if (attribute.type === 'complex' && next !== undefined) {
    // RFC 7644 §3.5.2.1/3: sub-attributes not given are left unchanged.
    write(container, attribute, { ...(isObject(current) ? current : {}), ...(next as JsonObject) });
    return;
  }
  if (next === undefined && op === 'add') return;
  write(container, attribute, next);
}

function applyUnfilteredSub(
  container: JsonObject,
  op: PatchOperationName,
  attribute: AttributeDefinition,
  sub: AttributeDefinition,
  value: unknown,
  label: string,
  options: ApplyPatchOptions,
): void {
  const elements = (Array.isArray(container[attribute.name]) ? (container[attribute.name] as unknown[]) : [])
    .filter(isObject)
    .map((element) => ({ ...element }));
  if (op === 'remove') {
    for (const element of elements) {
      assertMutable(sub, element[sub.name], op, value, label, options);
      Reflect.deleteProperty(element, sub.name);
    }
    write(container, attribute, elements);
    return;
  }
  const next = normalizeValue(sub, value, label, options);
  if (elements.length === 0) {
    if (next !== undefined) write(container, attribute, [{ [sub.name]: next }]);
    return;
  }
  let index = 0;
  if (elements.length > 1) {
    index = elements.findIndex((element) => element['primary'] === true);
    if (index === -1) {
      throw ScimError.noTarget(
        `"${label}" matches several values; select one with a filter such as ${attribute.name}[type eq "work"].${sub.name}.`,
      );
    }
  }
  const element = elements[index] as JsonObject;
  assertMutable(sub, element[sub.name], op, value, label, options);
  setOrDelete(element, sub, next);
  if (sub.name === 'primary' && next === true) clearOtherPrimaries(elements, [element]);
  write(container, attribute, elements);
}

function applyFiltered(
  container: JsonObject,
  op: PatchOperationName,
  attribute: AttributeDefinition,
  sub: AttributeDefinition | undefined,
  filter: ResolvedFilter,
  value: unknown,
  label: string,
  options: ApplyPatchOptions,
): void {
  const current = container[attribute.name];
  const elements = (
    attribute.multiValued ? (Array.isArray(current) ? current : []) : isObject(current) ? [current] : []
  )
    .filter(isObject)
    .map((element) => ({ ...element }));
  const matches = elements.filter((element) => evaluateElement(filter, element));

  if (op === 'remove') {
    if (matches.length === 0) {
      if (!options.lenient) throw ScimError.noTarget(`No value of "${attribute.name}" matches "${label}".`);
      return;
    }
    if (sub === undefined) {
      writeElements(
        container,
        attribute,
        elements.filter((element) => !matches.includes(element)),
      );
    } else {
      for (const element of matches) {
        assertMutable(sub, element[sub.name], op, value, label, options);
        Reflect.deleteProperty(element, sub.name);
      }
      writeElements(container, attribute, elements);
    }
    return;
  }

  const next =
    sub === undefined
      ? normalizeElement(attribute, value, label, options)
      : normalizeValue(sub, value, label, options);
  if (matches.length === 0) {
    const seed = options.lenient ? equalitySeed(filter) : undefined;
    if (seed === undefined) throw ScimError.noTarget(`No value of "${attribute.name}" matches "${label}".`);
    if (next === undefined) return;
    const created = sub === undefined ? { ...seed, ...(next as JsonObject) } : { ...seed, [sub.name]: next };
    elements.push(created);
    if (created['primary'] === true) clearOtherPrimaries(elements, [created]);
    writeElements(container, attribute, elements);
    return;
  }
  for (const element of matches) {
    if (sub === undefined) {
      if (isObject(next)) Object.assign(element, next);
    } else {
      assertMutable(sub, element[sub.name], op, value, label, options);
      setOrDelete(element, sub, next);
    }
  }
  const madePrimary =
    sub === undefined ? isObject(next) && next['primary'] === true : sub.name === 'primary' && next === true;
  if (madePrimary) clearOtherPrimaries(elements, matches);
  writeElements(container, attribute, elements);
}

function writeElements(container: JsonObject, attribute: AttributeDefinition, elements: JsonObject[]): void {
  const kept = elements.filter(isPresent);
  if (attribute.multiValued) write(container, attribute, kept);
  else write(container, attribute, kept[0]);
}

function write(container: JsonObject, attribute: AttributeDefinition, value: unknown): void {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    Reflect.deleteProperty(container, attribute.name);
  } else if (Array.isArray(value)) {
    const kept = value.filter(isPresent);
    if (kept.length === 0) {
      Reflect.deleteProperty(container, attribute.name);
    } else container[attribute.name] = kept;
  } else {
    container[attribute.name] = value;
  }
}

function setOrDelete(object: JsonObject, sub: AttributeDefinition, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(object, sub.name);
  else object[sub.name] = value;
}

function containerOf(data: JsonObject, schema: string | undefined, create: boolean): JsonObject | undefined {
  if (schema === undefined) return data;
  const existing = data[schema];
  if (isObject(existing)) return existing;
  if (!create) return undefined;
  const created: JsonObject = {};
  data[schema] = created;
  return created;
}

function assertMutable(
  definition: AttributeDefinition,
  current: unknown,
  op: PatchOperationName,
  value: unknown,
  label: string,
  options: ApplyPatchOptions,
): void {
  if (definition.mutability !== 'immutable' || !isPresent(current)) return;
  if (op !== 'remove' && deepEqual(normalizeValue(definition, value, label, options), current)) return;
  throw ScimError.mutability(`"${label}" is immutable.`);
}

/** Elements are the same value when their `value` sub-attributes are equal, else when they are equal. */
function sameElement(left: unknown, right: unknown, attribute: AttributeDefinition): boolean {
  const valueSub = attribute.type === 'complex' ? findSubAttribute(attribute, 'value') : undefined;
  const value = isObject(right) ? right['value'] : undefined;
  if (valueSub !== undefined && isObject(left) && (typeof value === 'string' || typeof value === 'number')) {
    return compareValue(left['value'], 'eq', String(value), valueSub);
  }
  return deepEqual(left, right);
}

function mergeElements(current: unknown, incoming: unknown[], attribute: AttributeDefinition): unknown[] {
  const result: unknown[] = Array.isArray(current)
    ? (current as unknown[]).map((item) => (isObject(item) ? { ...item } : item))
    : [];
  const touched: JsonObject[] = [];
  for (const item of incoming) {
    const index = result.findIndex((existing) => sameElement(existing, item, attribute));
    if (index === -1) {
      result.push(item);
      if (isObject(item)) touched.push(item);
    } else if (isObject(item) && isObject(result[index])) {
      const merged = { ...result[index], ...item };
      result[index] = merged;
      touched.push(merged);
    }
  }
  const primaries = touched.filter((element) => element['primary'] === true);
  if (primaries.length > 0) clearOtherPrimaries(result.filter(isObject), primaries.slice(-1));
  return result;
}

/** Only one element can be primary (RFC 7643 §2.4); the one just set wins. */
function clearOtherPrimaries(elements: JsonObject[], keep: readonly JsonObject[]): void {
  for (const element of elements) {
    if (!keep.includes(element) && element['primary'] === true) element['primary'] = false;
  }
}

/**
 * The element a value filter describes, when it is a conjunction of `eq`
 * comparisons: `type eq "work" and primary eq true` → {type: "work", primary: true}.
 */
function equalitySeed(filter: ResolvedFilter): JsonObject | undefined {
  if (filter.type === 'compare' && filter.operator === 'eq' && filter.path.subAttribute !== undefined) {
    return { [filter.path.subAttribute.name]: filter.value };
  }
  if (filter.type === 'and') {
    const seed: JsonObject = {};
    for (const inner of filter.filters) {
      const part = equalitySeed(inner);
      if (part === undefined) return undefined;
      Object.assign(seed, part);
    }
    return seed;
  }
  return undefined;
}
