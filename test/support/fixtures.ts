import {
  type CompiledResourceType,
  CompiledResourceType as Compiled,
} from '../../src/schema/resource-type.js';
import {
  GroupResourceType,
  type JsonObject,
  parseFilter,
  type ResolvedFilter,
  UserResourceType,
} from 'scimkit';
import { resolveFilter } from '../../src/filter/resolve.js';

export const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export const userType: CompiledResourceType = new Compiled(UserResourceType);
export const groupType: CompiledResourceType = new Compiled(GroupResourceType);

export function resolve(text: string, type: CompiledResourceType = userType, lenient = true): ResolvedFilter {
  return resolveFilter(parseFilter(text), type, { lenient });
}

/** Barbara Jensen, after RFC 7643 §8.2. */
export function barbara(): JsonObject {
  return {
    id: '2819c223-7f76-453a-919d-413861904646',
    externalId: 'bjensen',
    userName: 'bjensen@example.com',
    name: { formatted: 'Ms. Barbara J Jensen III', familyName: 'Jensen', givenName: 'Barbara' },
    displayName: 'Babs Jensen',
    title: 'Tour Guide',
    userType: 'Employee',
    active: true,
    emails: [
      { value: 'bjensen@example.com', type: 'work', primary: true },
      { value: 'babs@jensen.org', type: 'home' },
    ],
    phoneNumbers: [{ value: '555-555-5555', type: 'work' }],
    groups: [{ value: 'e9e30dba-f08f-4109-8486-d5c6a331660a', display: 'Tour Guides', type: 'direct' }],
    [ENTERPRISE]: {
      employeeNumber: '701984',
      department: 'Tour Operations',
      manager: { value: '26118915-6090-4610-87e4-49d8ca9f808d', displayName: 'John Smith' },
    },
    meta: {
      resourceType: 'User',
      created: '2010-01-23T04:56:22Z',
      lastModified: '2011-05-13T04:42:34Z',
    },
  };
}
