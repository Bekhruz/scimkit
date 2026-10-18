import { SCIM_SCHEMAS } from '../constants.js';
import type { JsonObject } from '../resource/json.js';
import type { AttributeDefinition, SchemaDefinition } from '../schema/definitions.js';
import type { ResourceTypeDefinition } from '../schema/resource-type.js';

export interface AuthenticationScheme {
  type: string;
  name: string;
  description: string;
  specUri?: string;
  documentationUri?: string;
  primary?: boolean;
}

export const BEARER_TOKEN_SCHEME: AuthenticationScheme = {
  type: 'oauthbearertoken',
  name: 'OAuth Bearer Token',
  description: 'Authentication with a bearer token in the Authorization header.',
  specUri: 'https://www.rfc-editor.org/info/rfc6750',
  primary: true,
};

export interface ServiceProviderFeatures {
  documentationUri?: string;
  bulk: { supported: boolean; maxOperations: number; maxPayloadSize: number };
  maxResults: number;
  changePassword: boolean;
  authenticationSchemes: readonly AuthenticationScheme[];
}

export function serviceProviderConfig(features: ServiceProviderFeatures, baseUrl: string): JsonObject {
  return {
    schemas: [SCIM_SCHEMAS.serviceProviderConfig],
    ...(features.documentationUri === undefined ? {} : { documentationUri: features.documentationUri }),
    patch: { supported: true },
    bulk: features.bulk,
    filter: { supported: true, maxResults: features.maxResults },
    changePassword: { supported: features.changePassword },
    sort: { supported: true },
    etag: { supported: true },
    authenticationSchemes: features.authenticationSchemes,
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypeResource(type: ResourceTypeDefinition, baseUrl: string): JsonObject {
  return {
    schemas: [SCIM_SCHEMAS.resourceType],
    id: type.name,
    name: type.name,
    endpoint: type.endpoint,
    description: type.description,
    schema: type.schema.id,
    schemaExtensions: type.extensions.map((extension) => ({
      schema: extension.schema.id,
      required: extension.required,
    })),
    meta: {
      resourceType: 'ResourceType',
      location: `${baseUrl}/ResourceTypes/${encodeURIComponent(type.name)}`,
    },
  };
}

function attributeResource(attribute: AttributeDefinition): JsonObject {
  return {
    name: attribute.name,
    type: attribute.type,
    multiValued: attribute.multiValued,
    description: attribute.description,
    required: attribute.required,
    ...(attribute.canonicalValues === undefined ? {} : { canonicalValues: attribute.canonicalValues }),
    caseExact: attribute.caseExact,
    mutability: attribute.mutability,
    returned: attribute.returned,
    uniqueness: attribute.uniqueness,
    ...(attribute.referenceTypes === undefined ? {} : { referenceTypes: attribute.referenceTypes }),
    ...(attribute.subAttributes === undefined
      ? {}
      : { subAttributes: attribute.subAttributes.map(attributeResource) }),
  };
}

export function schemaResource(schema: SchemaDefinition, baseUrl: string): JsonObject {
  return {
    schemas: [SCIM_SCHEMAS.schema],
    id: schema.id,
    name: schema.name,
    description: schema.description,
    attributes: schema.attributes.map(attributeResource),
    meta: { resourceType: 'Schema', location: `${baseUrl}/Schemas/${schema.id}` },
  };
}
