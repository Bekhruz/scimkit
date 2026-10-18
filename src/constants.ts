/** Schema URNs defined by RFC 7643 and message URNs defined by RFC 7644. */
export const SCIM_SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  enterpriseUser: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  serviceProviderConfig: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

export const SCIM_MESSAGES = {
  listResponse: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  searchRequest: 'urn:ietf:params:scim:api:messages:2.0:SearchRequest',
  patchOp: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  bulkRequest: 'urn:ietf:params:scim:api:messages:2.0:BulkRequest',
  bulkResponse: 'urn:ietf:params:scim:api:messages:2.0:BulkResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

export const SCIM_CONTENT_TYPE = 'application/scim+json';
