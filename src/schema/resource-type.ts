import { SCIM_SCHEMAS } from '../constants.js';
import { COMMON_ATTRIBUTES, ENTERPRISE_USER_SCHEMA, GROUP_SCHEMA, USER_SCHEMA } from './core.js';
import type { AttributeDefinition, SchemaDefinition } from './definitions.js';

export interface SchemaExtension {
  readonly schema: SchemaDefinition;
  readonly required: boolean;
}

/** A resource type (RFC 7643 §6): a name, an endpoint, a core schema and extensions. */
export interface ResourceTypeDefinition {
  readonly name: string;
  readonly endpoint: string;
  readonly description: string;
  readonly schema: SchemaDefinition;
  readonly extensions: readonly SchemaExtension[];
}

export interface ResourceTypeInput {
  name: string;
  /** Defaults to `/<name>s`, for example `/Devices`. */
  endpoint?: string;
  description?: string;
  schema: SchemaDefinition;
  extensions?: readonly (SchemaDefinition | { schema: SchemaDefinition; required?: boolean })[];
}

const RESERVED_ENDPOINTS = new Set([
  'serviceproviderconfig',
  'resourcetypes',
  'schemas',
  'bulk',
  'me',
  '.search',
]);

export function defineResourceType(input: ResourceTypeInput): ResourceTypeDefinition {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.name)) {
    throw new TypeError(`Invalid resource type name "${input.name}".`);
  }
  const endpoint = input.endpoint ?? `/${input.name}s`;
  if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(endpoint)) {
    throw new TypeError(
      `Endpoint "${endpoint}" of ${input.name} must be one path segment such as "/Devices".`,
    );
  }
  if (RESERVED_ENDPOINTS.has(endpoint.slice(1).toLowerCase())) {
    throw new TypeError(`Endpoint "${endpoint}" is reserved by SCIM.`);
  }
  const extensions = (input.extensions ?? []).map((extension) =>
    'attributes' in extension
      ? { schema: extension, required: false }
      : { schema: extension.schema, required: extension.required ?? false },
  );
  const urns = new Set([input.schema.id.toLowerCase()]);
  for (const extension of extensions) {
    const urn = extension.schema.id.toLowerCase();
    if (urns.has(urn)) throw new TypeError(`Schema ${extension.schema.id} is used twice by ${input.name}.`);
    urns.add(urn);
  }
  return Object.freeze({
    name: input.name,
    endpoint,
    description: input.description ?? input.name,
    schema: input.schema,
    extensions: Object.freeze(extensions.map((extension) => Object.freeze(extension))),
  });
}

/** The User resource type, with the optional Enterprise User extension. */
export const UserResourceType = defineResourceType({
  name: 'User',
  endpoint: '/Users',
  description: 'User Account',
  schema: USER_SCHEMA,
  extensions: [{ schema: ENTERPRISE_USER_SCHEMA, required: false }],
});

/** The Group resource type. */
export const GroupResourceType = defineResourceType({
  name: 'Group',
  endpoint: '/Groups',
  description: 'Group',
  schema: GROUP_SCHEMA,
});

/** An attribute together with the schema that defines it. */
export interface LocatedAttribute {
  /** URN of the schema the attribute belongs to; the core schema for common attributes. */
  readonly schema: string;
  /** True when the attribute lives in an extension object rather than at the top level. */
  readonly extension: boolean;
  readonly definition: AttributeDefinition;
}

/**
 * A resource type with case-insensitive lookups of its attributes and schema
 * URNs, built once when the server starts. Not part of the public API.
 */
export class CompiledResourceType {
  readonly name: string;
  readonly endpoint: string;
  readonly coreUrn: string;
  readonly isUser: boolean;
  readonly isGroup: boolean;
  private readonly core = new Map<string, AttributeDefinition>();
  private readonly extensionsByUrn = new Map<string, SchemaExtension>();
  private readonly extensionAttributes = new Map<string, Map<string, AttributeDefinition>>();
  private readonly urnsLongestFirst: string[];

  constructor(readonly definition: ResourceTypeDefinition) {
    this.name = definition.name;
    this.endpoint = definition.endpoint;
    this.coreUrn = definition.schema.id;
    this.isUser = this.coreUrn === SCIM_SCHEMAS.user;
    this.isGroup = this.coreUrn === SCIM_SCHEMAS.group;
    for (const attribute of [...COMMON_ATTRIBUTES, ...definition.schema.attributes]) {
      this.core.set(attribute.name.toLowerCase(), attribute);
    }
    for (const extension of definition.extensions) {
      const urn = extension.schema.id.toLowerCase();
      this.extensionsByUrn.set(urn, extension);
      this.extensionAttributes.set(
        urn,
        new Map(extension.schema.attributes.map((attribute) => [attribute.name.toLowerCase(), attribute])),
      );
    }
    this.urnsLongestFirst = [
      this.coreUrn,
      ...definition.extensions.map((extension) => extension.schema.id),
    ].sort((a, b) => b.length - a.length);
  }

  /** A top-level attribute of the core schema or a common attribute. */
  coreAttribute(name: string): AttributeDefinition | undefined {
    return this.core.get(name.toLowerCase());
  }

  extension(urn: string): SchemaExtension | undefined {
    return this.extensionsByUrn.get(urn.toLowerCase());
  }

  get extensions(): readonly SchemaExtension[] {
    return this.definition.extensions;
  }

  /** Looks up an attribute in the schema with the given URN (core or extension). */
  attributeIn(urn: string, name: string): LocatedAttribute | undefined {
    if (urn.toLowerCase() === this.coreUrn.toLowerCase()) {
      const definition = this.coreAttribute(name);
      return definition === undefined ? undefined : { schema: this.coreUrn, extension: false, definition };
    }
    const extension = this.extensionsByUrn.get(urn.toLowerCase());
    const definition = this.extensionAttributes.get(urn.toLowerCase())?.get(name.toLowerCase());
    return extension === undefined || definition === undefined
      ? undefined
      : { schema: extension.schema.id, extension: true, definition };
  }

  /**
   * Splits a URN-qualified path such as
   * `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager.value`
   * into the schema URN and the rest. A text that is exactly a URN yields an
   * empty rest. Returns undefined when the text starts with none of this
   * resource type's schema URNs.
   */
  splitUrn(text: string): { urn: string; rest: string } | undefined {
    const lower = text.toLowerCase();
    for (const urn of this.urnsLongestFirst) {
      const candidate = urn.toLowerCase();
      if (lower === candidate) return { urn, rest: '' };
      if (lower.startsWith(`${candidate}:`)) return { urn, rest: text.slice(urn.length + 1) };
    }
    return undefined;
  }

  /** All schema URNs of the resource type, core first. */
  get schemaUrns(): readonly string[] {
    return [this.coreUrn, ...this.definition.extensions.map((extension) => extension.schema.id)];
  }

  /** Whether an attribute definition is one of the common attributes (id, externalId, meta). */
  isCommon(definition: AttributeDefinition): boolean {
    return COMMON_ATTRIBUTES.includes(definition);
  }
}
