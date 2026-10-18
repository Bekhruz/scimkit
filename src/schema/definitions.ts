/** Attribute data types (RFC 7643 §2.3). */
export type AttributeType =
  'string' | 'boolean' | 'decimal' | 'integer' | 'dateTime' | 'reference' | 'complex' | 'binary';

/** Attribute mutability (RFC 7643 §7). */
export type Mutability = 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';

/** When an attribute is returned (RFC 7643 §7). */
export type Returned = 'always' | 'never' | 'default' | 'request';

/** Attribute uniqueness (RFC 7643 §7). */
export type Uniqueness = 'none' | 'server' | 'global';

/** A fully specified attribute, as published at `/Schemas`. */
export interface AttributeDefinition {
  readonly name: string;
  readonly type: AttributeType;
  readonly multiValued: boolean;
  readonly description: string;
  readonly required: boolean;
  readonly caseExact: boolean;
  readonly mutability: Mutability;
  readonly returned: Returned;
  readonly uniqueness: Uniqueness;
  readonly canonicalValues?: readonly string[];
  readonly referenceTypes?: readonly string[];
  readonly subAttributes?: readonly AttributeDefinition[];
}

/**
 * An attribute as written by hand. Omitted characteristics take the RFC 7643
 * §2.2 defaults: a single-valued, optional, case-insensitive, readWrite
 * string that is returned by default and has no uniqueness constraint.
 */
export interface AttributeInput {
  name: string;
  type?: AttributeType;
  multiValued?: boolean;
  description?: string;
  required?: boolean;
  caseExact?: boolean;
  mutability?: Mutability;
  returned?: Returned;
  uniqueness?: Uniqueness;
  canonicalValues?: readonly string[];
  referenceTypes?: readonly string[];
  subAttributes?: readonly AttributeInput[];
}

/** A schema: a URN and the attributes it defines. */
export interface SchemaDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly attributes: readonly AttributeDefinition[];
}

export interface SchemaInput {
  /** The schema URN, for example `urn:example:params:scim:schemas:extension:acme:2.0:User`. */
  id: string;
  name?: string;
  description?: string;
  attributes: readonly AttributeInput[];
}

/** Attribute names: ALPHA *(nameChar), plus the reserved `$ref`. */
export const ATTRIBUTE_NAME = /^(?:[A-Za-z][A-Za-z0-9_-]*|\$ref)$/;

/** URNs (RFC 8141), loosely: `urn:<nid>:<nss>` without whitespace or brackets. */
export const SCHEMA_URN = /^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[^\s[\]"]+$/;

const TYPES = new Set<AttributeType>([
  'string',
  'boolean',
  'decimal',
  'integer',
  'dateTime',
  'reference',
  'complex',
  'binary',
]);
const MUTABILITY = new Set<Mutability>(['readOnly', 'readWrite', 'immutable', 'writeOnly']);
const RETURNED = new Set<Returned>(['always', 'never', 'default', 'request']);
const UNIQUENESS = new Set<Uniqueness>(['none', 'server', 'global']);

/** Builds an attribute definition, filling in RFC defaults and validating it. */
export function defineAttribute(input: AttributeInput, parent?: string): AttributeDefinition {
  const where =
    parent === undefined ? `attribute "${input.name}"` : `sub-attribute "${parent}.${input.name}"`;
  if (!ATTRIBUTE_NAME.test(input.name)) throw new TypeError(`Invalid name for ${where}.`);
  const type = input.type ?? 'string';
  if (!TYPES.has(type)) throw new TypeError(`Unknown type "${type}" for ${where}.`);
  const mutability = input.mutability ?? 'readWrite';
  if (!MUTABILITY.has(mutability)) throw new TypeError(`Unknown mutability "${mutability}" for ${where}.`);
  const returned = input.returned ?? 'default';
  if (!RETURNED.has(returned)) throw new TypeError(`Unknown returned value "${returned}" for ${where}.`);
  const uniqueness = input.uniqueness ?? 'none';
  if (!UNIQUENESS.has(uniqueness)) throw new TypeError(`Unknown uniqueness "${uniqueness}" for ${where}.`);

  let subAttributes: AttributeDefinition[] | undefined;
  if (type === 'complex') {
    if (parent !== undefined)
      throw new TypeError(`${where} is complex; complex attributes cannot be nested.`);
    if (input.subAttributes === undefined || input.subAttributes.length === 0) {
      throw new TypeError(`Complex ${where} needs at least one sub-attribute.`);
    }
    subAttributes = input.subAttributes.map((sub) => defineAttribute(sub, input.name));
    assertUniqueNames(subAttributes, `sub-attributes of "${input.name}"`);
  } else if (input.subAttributes !== undefined) {
    throw new TypeError(`Only complex attributes have sub-attributes (${where} is ${type}).`);
  }

  const definition: AttributeDefinition = {
    name: input.name,
    type,
    multiValued: input.multiValued ?? false,
    description: input.description ?? '',
    required: input.required ?? false,
    caseExact: input.caseExact ?? false,
    mutability,
    returned,
    uniqueness,
    ...(input.canonicalValues === undefined
      ? {}
      : { canonicalValues: Object.freeze([...input.canonicalValues]) }),
    ...(input.referenceTypes === undefined
      ? {}
      : { referenceTypes: Object.freeze([...input.referenceTypes]) }),
    ...(subAttributes === undefined ? {} : { subAttributes: Object.freeze(subAttributes) }),
  };
  return Object.freeze(definition);
}

/** Builds a schema definition, filling in RFC defaults and validating it. */
export function defineSchema(input: SchemaInput): SchemaDefinition {
  if (!SCHEMA_URN.test(input.id)) throw new TypeError(`Schema id "${input.id}" is not a URN.`);
  const attributes = input.attributes.map((attribute) => defineAttribute(attribute));
  assertUniqueNames(attributes, `attributes of ${input.id}`);
  for (const reserved of ['id', 'externalId', 'meta', 'schemas']) {
    if (attributes.some((attribute) => attribute.name.toLowerCase() === reserved.toLowerCase())) {
      throw new TypeError(`"${reserved}" is a common attribute and cannot be redefined in ${input.id}.`);
    }
  }
  return Object.freeze({
    id: input.id,
    name: input.name ?? input.id.slice(input.id.lastIndexOf(':') + 1),
    description: input.description ?? '',
    attributes: Object.freeze(attributes),
  });
}

/** Overrides of an attribute's characteristics, by attribute or `parent.sub` name. */
export type AttributeOverrides = Readonly<
  Record<string, Partial<Omit<AttributeInput, 'name' | 'type' | 'subAttributes'>>>
>;

/**
 * Derives a schema from an existing one: change characteristics of existing
 * attributes (for example make Group `displayName` unique) and add attributes.
 */
export function customizeSchema(
  schema: SchemaDefinition,
  changes: { overrides?: AttributeOverrides; add?: readonly AttributeInput[]; description?: string },
): SchemaDefinition {
  const overrides = new Map(
    Object.entries(changes.overrides ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const used = new Set<string>();
  const apply = (attribute: AttributeDefinition, prefix: string): AttributeInput => {
    const key = `${prefix}${attribute.name}`.toLowerCase();
    const override = overrides.get(key);
    if (override !== undefined) used.add(key);
    return {
      ...toInput(attribute),
      ...override,
      ...(attribute.subAttributes === undefined
        ? {}
        : { subAttributes: attribute.subAttributes.map((sub) => apply(sub, `${attribute.name}.`)) }),
    };
  };
  const attributes = schema.attributes.map((attribute) => apply(attribute, ''));
  for (const key of overrides.keys()) {
    if (!used.has(key)) throw new TypeError(`Cannot override unknown attribute "${key}" of ${schema.id}.`);
  }
  return defineSchema({
    id: schema.id,
    name: schema.name,
    description: changes.description ?? schema.description,
    attributes: [...attributes, ...(changes.add ?? [])],
  });
}

function toInput(attribute: AttributeDefinition): AttributeInput {
  return {
    name: attribute.name,
    type: attribute.type,
    multiValued: attribute.multiValued,
    description: attribute.description,
    required: attribute.required,
    caseExact: attribute.caseExact,
    mutability: attribute.mutability,
    returned: attribute.returned,
    uniqueness: attribute.uniqueness,
    ...(attribute.canonicalValues === undefined ? {} : { canonicalValues: attribute.canonicalValues }),
    ...(attribute.referenceTypes === undefined ? {} : { referenceTypes: attribute.referenceTypes }),
    ...(attribute.subAttributes === undefined ? {} : { subAttributes: attribute.subAttributes.map(toInput) }),
  };
}

function assertUniqueNames(attributes: readonly AttributeDefinition[], where: string): void {
  const seen = new Set<string>();
  for (const attribute of attributes) {
    const key = attribute.name.toLowerCase();
    if (seen.has(key)) throw new TypeError(`Duplicate attribute "${attribute.name}" in ${where}.`);
    seen.add(key);
  }
}

/** Finds a sub-attribute by name, case-insensitively. */
export function findSubAttribute(
  attribute: AttributeDefinition,
  name: string,
): AttributeDefinition | undefined {
  const lower = name.toLowerCase();
  return attribute.subAttributes?.find((sub) => sub.name.toLowerCase() === lower);
}
