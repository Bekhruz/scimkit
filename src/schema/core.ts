import { SCIM_SCHEMAS } from '../constants.js';
import {
  type AttributeDefinition,
  type AttributeInput,
  type AttributeType,
  defineAttribute,
  defineSchema,
} from './definitions.js';

/**
 * Attributes every resource has (RFC 7643 §3.1). They are not part of any
 * published schema, but they can be filtered, sorted and selected like any
 * other attribute.
 */
export const COMMON_ATTRIBUTES: readonly AttributeDefinition[] = Object.freeze([
  defineAttribute({
    name: 'id',
    description: 'Unique identifier of the resource, assigned by the service provider.',
    caseExact: true,
    mutability: 'readOnly',
    returned: 'always',
    uniqueness: 'server',
  }),
  defineAttribute({
    name: 'externalId',
    description: 'Identifier of the resource as defined by the provisioning client.',
    caseExact: true,
  }),
  defineAttribute({
    name: 'meta',
    type: 'complex',
    description: 'Resource metadata.',
    mutability: 'readOnly',
    subAttributes: [
      {
        name: 'resourceType',
        caseExact: true,
        mutability: 'readOnly',
        description: 'Name of the resource type.',
      },
      {
        name: 'created',
        type: 'dateTime',
        mutability: 'readOnly',
        description: 'When the resource was added.',
      },
      {
        name: 'lastModified',
        type: 'dateTime',
        mutability: 'readOnly',
        description: 'When the resource was last changed.',
      },
      {
        name: 'location',
        type: 'reference',
        referenceTypes: ['uri'],
        caseExact: true,
        mutability: 'readOnly',
        description: 'URI of the resource.',
      },
      {
        name: 'version',
        caseExact: true,
        mutability: 'readOnly',
        description: 'Version of the resource, the value of its ETag.',
      },
    ],
  }),
]);

function multiValue(
  name: string,
  description: string,
  options: { types?: readonly string[]; valueType?: AttributeType; referenceTypes?: readonly string[] } = {},
): AttributeInput {
  return {
    name,
    type: 'complex',
    multiValued: true,
    description,
    subAttributes: [
      {
        name: 'value',
        type: options.valueType ?? 'string',
        description: `The ${name} value.`,
        ...(options.referenceTypes === undefined ? {} : { referenceTypes: options.referenceTypes }),
      },
      { name: 'display', description: 'Human-readable name, for display only.' },
      {
        name: 'type',
        description: 'Label of the value function.',
        ...(options.types === undefined ? {} : { canonicalValues: options.types }),
      },
      { name: 'primary', type: 'boolean', description: 'Whether this is the preferred value.' },
    ],
  };
}

/** The core User schema (RFC 7643 §4.1). */
export const USER_SCHEMA = defineSchema({
  id: SCIM_SCHEMAS.user,
  name: 'User',
  description: 'User Account',
  attributes: [
    {
      name: 'userName',
      description: 'Unique identifier the user signs in with.',
      required: true,
      uniqueness: 'server',
    },
    {
      name: 'name',
      type: 'complex',
      description: "Components of the user's name.",
      subAttributes: [
        { name: 'formatted', description: 'Full name, formatted for display.' },
        { name: 'familyName', description: 'Family name, or last name.' },
        { name: 'givenName', description: 'Given name, or first name.' },
        { name: 'middleName', description: 'Middle name.' },
        { name: 'honorificPrefix', description: 'Honorific prefix, for example "Ms.".' },
        { name: 'honorificSuffix', description: 'Honorific suffix, for example "III".' },
      ],
    },
    { name: 'displayName', description: 'Name of the user, suitable for display.' },
    { name: 'nickName', description: 'Casual name of the user.' },
    {
      name: 'profileUrl',
      type: 'reference',
      referenceTypes: ['external'],
      description: "URL of the user's online profile.",
    },
    { name: 'title', description: "The user's title, for example 'Vice President'." },
    { name: 'userType', description: "Relationship to the organization, for example 'Employee'." },
    { name: 'preferredLanguage', description: 'Preferred written or spoken language.' },
    { name: 'locale', description: 'Default location, for localizing values such as currency.' },
    { name: 'timezone', description: "The user's time zone, in IANA format." },
    { name: 'active', type: 'boolean', description: 'Whether the account is active.' },
    {
      name: 'password',
      description: 'Clear-text password. Never stored by scimkit and never returned.',
      mutability: 'writeOnly',
      returned: 'never',
    },
    multiValue('emails', 'Email addresses.', { types: ['work', 'home', 'other'] }),
    multiValue('phoneNumbers', 'Phone numbers.', {
      types: ['work', 'home', 'mobile', 'fax', 'pager', 'other'],
    }),
    multiValue('ims', 'Instant messaging addresses.', {
      types: ['aim', 'gtalk', 'icq', 'xmpp', 'msn', 'skype', 'qq', 'yahoo'],
    }),
    multiValue('photos', 'URLs of photos of the user.', {
      types: ['photo', 'thumbnail'],
      valueType: 'reference',
      referenceTypes: ['external'],
    }),
    {
      name: 'addresses',
      type: 'complex',
      multiValued: true,
      description: 'Physical mailing addresses.',
      subAttributes: [
        { name: 'formatted', description: 'Full address, formatted for display.' },
        { name: 'streetAddress', description: 'Street address.' },
        { name: 'locality', description: 'City or locality.' },
        { name: 'region', description: 'State or region.' },
        { name: 'postalCode', description: 'Postal code.' },
        { name: 'country', description: 'Country, as an ISO 3166-1 alpha-2 code.' },
        { name: 'type', canonicalValues: ['work', 'home', 'other'], description: 'Label of the address.' },
        { name: 'primary', type: 'boolean', description: 'Whether this is the preferred address.' },
      ],
    },
    {
      name: 'groups',
      type: 'complex',
      multiValued: true,
      description: 'Groups the user belongs to, maintained through the Group resources.',
      mutability: 'readOnly',
      subAttributes: [
        { name: 'value', caseExact: true, mutability: 'readOnly', description: 'Identifier of the group.' },
        {
          name: '$ref',
          type: 'reference',
          referenceTypes: ['User', 'Group'],
          caseExact: true,
          mutability: 'readOnly',
          description: 'URI of the group.',
        },
        { name: 'display', mutability: 'readOnly', description: 'Name of the group.' },
        {
          name: 'type',
          canonicalValues: ['direct', 'indirect'],
          mutability: 'readOnly',
          description: 'Whether the membership is direct or through another group.',
        },
      ],
    },
    multiValue('entitlements', 'Entitlements of the user.'),
    multiValue('roles', 'Roles of the user.'),
    multiValue('x509Certificates', 'X.509 certificates of the user.', { valueType: 'binary' }),
  ],
});

/** The core Group schema (RFC 7643 §4.2). */
export const GROUP_SCHEMA = defineSchema({
  id: SCIM_SCHEMAS.group,
  name: 'Group',
  description: 'Group',
  attributes: [
    { name: 'displayName', description: 'Name of the group.', required: true },
    {
      name: 'members',
      type: 'complex',
      multiValued: true,
      description: 'Members of the group.',
      subAttributes: [
        { name: 'value', caseExact: true, mutability: 'immutable', description: 'Identifier of the member.' },
        {
          name: '$ref',
          type: 'reference',
          referenceTypes: ['User', 'Group'],
          caseExact: true,
          mutability: 'immutable',
          description: 'URI of the member.',
        },
        {
          name: 'type',
          canonicalValues: ['User', 'Group'],
          mutability: 'immutable',
          description: 'Resource type of the member.',
        },
        { name: 'display', mutability: 'readOnly', description: 'Name of the member.' },
      ],
    },
  ],
});

/** The Enterprise User extension (RFC 7643 §4.3). */
export const ENTERPRISE_USER_SCHEMA = defineSchema({
  id: SCIM_SCHEMAS.enterpriseUser,
  name: 'EnterpriseUser',
  description: 'Enterprise User',
  attributes: [
    { name: 'employeeNumber', description: 'Identifier assigned by the organization.' },
    { name: 'costCenter', description: 'Cost center.' },
    { name: 'organization', description: 'Organization.' },
    { name: 'division', description: 'Division.' },
    { name: 'department', description: 'Department.' },
    {
      name: 'manager',
      type: 'complex',
      description: "The user's manager.",
      subAttributes: [
        { name: 'value', caseExact: true, description: 'Identifier of the manager.' },
        {
          name: '$ref',
          type: 'reference',
          referenceTypes: ['User'],
          caseExact: true,
          description: 'URI of the manager.',
        },
        { name: 'displayName', mutability: 'readOnly', description: 'Name of the manager.' },
      ],
    },
  ],
});
