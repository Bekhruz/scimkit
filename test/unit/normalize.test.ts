import { describe, expect, it } from 'vitest';
import { customizeSchema, defineResourceType, defineSchema, ScimError, USER_SCHEMA } from 'scimkit';
import { normalizeAttributes, normalizeResourceBody } from '../../src/resource/normalize.js';
import { CompiledResourceType } from '../../src/schema/resource-type.js';
import { ENTERPRISE, groupType, userType } from '../support/fixtures.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const lenient = { lenient: true };
const strict = { lenient: false };

function error(run: () => unknown): ScimError {
  try {
    run();
  } catch (caught) {
    if (caught instanceof ScimError) return caught;
    throw caught;
  }
  throw new Error('Expected a ScimError');
}

describe('normalizeResourceBody', () => {
  it('canonicalises names, drops read-only values and unassigned values', () => {
    const { attributes } = normalizeResourceBody(
      {
        schemas: [USER, ENTERPRISE],
        id: 'client-chosen',
        meta: { resourceType: 'User' },
        UserName: 'ann',
        NAME: { GivenName: 'Ann', familyName: null },
        nickName: null,
        emails: [],
        groups: [{ value: 'g1' }],
        [ENTERPRISE.toLowerCase()]: {
          Department: 'R&D',
          manager: { value: 'm1', $ref: 'x', displayName: 'Bo' },
        },
      },
      userType,
      lenient,
    );
    expect(attributes).toEqual({
      userName: 'ann',
      name: { givenName: 'Ann' },
      [ENTERPRISE]: { department: 'R&D', manager: { value: 'm1' } },
    });
  });

  it('coerces values leniently and rejects them strictly', () => {
    const body = {
      schemas: [USER],
      userName: 'ann',
      active: 'False',
      emails: { value: 'a@x.io', primary: 'true' },
      title: 7,
    };
    expect(normalizeResourceBody(body, userType, lenient).attributes).toEqual({
      userName: 'ann',
      active: false,
      emails: [{ value: 'a@x.io', primary: true }],
      title: '7',
    });
    expect(error(() => normalizeResourceBody(body, userType, strict)).detail).toMatch(
      /"active" must be true or false/,
    );
  });

  it('keeps only one primary value', () => {
    const body = {
      schemas: [USER],
      userName: 'ann',
      emails: [
        { value: 'a@x.io', primary: true },
        { value: 'b@x.io', primary: true },
      ],
    };
    expect(normalizeResourceBody(body, userType, lenient).attributes['emails']).toEqual([
      { value: 'a@x.io', primary: true },
      { value: 'b@x.io', primary: false },
    ]);
    expect(error(() => normalizeResourceBody(body, userType, strict)).detail).toMatch(
      /Only one value of "emails"/,
    );
  });

  it('extracts the password and never keeps it with the attributes', () => {
    const result = normalizeResourceBody(
      { schemas: [USER], userName: 'ann', password: 'Secret#1' },
      userType,
      lenient,
    );
    expect(result.password).toBe('Secret#1');
    expect(result.attributes).toEqual({ userName: 'ann' });
  });

  it('accepts flattened extension attributes leniently', () => {
    const result = normalizeResourceBody(
      { schemas: [USER], userName: 'ann', [`${ENTERPRISE}:department`]: 'Ops' },
      userType,
      lenient,
    );
    expect(result.attributes).toEqual({ userName: 'ann', [ENTERPRISE]: { department: 'Ops' } });
  });

  it('ignores unknown attributes leniently and reports them', () => {
    const unknown: string[] = [];
    const result = normalizeResourceBody(
      { schemas: [USER], userName: 'ann', shoeSize: 9, name: { nick: 'A' }, [ENTERPRISE]: { badge: 1 } },
      userType,
      { lenient: true, onUnknownAttribute: (path) => unknown.push(path) },
    );
    expect(result.attributes).toEqual({ userName: 'ann' });
    expect(unknown).toEqual(['shoeSize', 'name.nick', `${ENTERPRISE}:badge`]);
    expect(
      error(() => normalizeResourceBody({ schemas: [USER], userName: 'a', shoeSize: 9 }, userType, strict))
        .detail,
    ).toBe('Unknown attribute "shoeSize".');
  });

  it('checks the schemas attribute', () => {
    expect(error(() => normalizeResourceBody({ userName: 'a' }, userType, strict)).detail).toMatch(
      /"schemas" attribute is required/,
    );
    expect(normalizeResourceBody({ userName: 'a' }, userType, lenient).attributes).toEqual({ userName: 'a' });
    expect(
      error(() => normalizeResourceBody({ schemas: 'x', userName: 'a' }, userType, lenient)).scimType,
    ).toBe('invalidSyntax');
    expect(
      error(() => normalizeResourceBody({ schemas: [ENTERPRISE], userName: 'a' }, userType, strict)).detail,
    ).toMatch(/must include urn:ietf:params:scim:schemas:core:2.0:User/);
    expect(
      error(() =>
        normalizeResourceBody({ schemas: [USER, 'urn:example:x'], userName: 'a' }, userType, strict),
      ).detail,
    ).toMatch(/not supported by User resources/);
    expect(error(() => normalizeResourceBody([], userType, lenient)).detail).toMatch(/must be a JSON object/);
  });

  it('requires required attributes', () => {
    expect(
      error(() => normalizeResourceBody({ schemas: [USER], name: { givenName: 'A' } }, userType, lenient))
        .detail,
    ).toBe('"userName" is required.');
    expect(
      error(() => normalizeResourceBody({ schemas: [USER], userName: null }, userType, lenient)).scimType,
    ).toBe('invalidValue');
    expect(error(() => normalizeResourceBody({ schemas: [], members: [] }, groupType, lenient)).detail).toBe(
      '"displayName" is required.',
    );
  });

  it('validates every attribute type', () => {
    const type = new CompiledResourceType(
      defineResourceType({
        name: 'Device',
        schema: defineSchema({
          id: 'urn:example:scim:Device',
          attributes: [
            { name: 'name', required: true },
            { name: 'ports', type: 'integer' },
            { name: 'weight', type: 'decimal' },
            { name: 'seen', type: 'dateTime' },
            { name: 'cert', type: 'binary' },
            { name: 'site', type: 'reference', referenceTypes: ['external'] },
            { name: 'tags', multiValued: true },
            {
              name: 'nic',
              type: 'complex',
              multiValued: true,
              subAttributes: [
                { name: 'mac', required: true },
                { name: 'speed', type: 'integer' },
              ],
            },
          ],
        }),
      }),
    );
    const base = { schemas: ['urn:example:scim:Device'], name: 'd1' };
    const ok = normalizeResourceBody(
      {
        ...base,
        ports: 4,
        weight: 1.25,
        seen: '2024-05-01T10:00:00.5+02:00',
        cert: 'AAEC',
        site: 'https://x.io',
        tags: ['a', 'b'],
        nic: [{ mac: 'aa', speed: '100' }],
      },
      type,
      lenient,
    );
    expect(ok.attributes).toMatchObject({ ports: 4, weight: 1.25, nic: [{ mac: 'aa', speed: 100 }] });
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ports: 1.5 }, /"ports" must be an integer/],
      [{ ports: 'four' }, /"ports" must be an integer/],
      [{ weight: 'heavy' }, /"weight" must be a number/],
      [{ seen: 'yesterday' }, /xsd:dateTime/],
      [{ cert: '!!' }, /base64/],
      [{ site: { url: 'x' } }, /"site" must be a string/],
      [{ nic: [{ speed: 1 }] }, /"nic.mac" is required/],
      [{ nic: ['x'] }, /"nic" must be an object/],
    ];
    for (const [patch, message] of bad) {
      expect(error(() => normalizeResourceBody({ ...base, ...patch }, type, lenient)).detail).toMatch(
        message,
      );
    }
    expect(error(() => normalizeResourceBody({ ...base, tags: 'a' }, type, strict)).detail).toMatch(
      /must be an array/,
    );
    expect(error(() => normalizeResourceBody({ ...base, cert: 'AA_-' }, type, strict)).detail).toMatch(
      /base64/,
    );
    expect(normalizeResourceBody({ ...base, cert: 'AA_-' }, type, lenient).attributes['cert']).toBe('AA_-');
  });

  it('refuses keys that could pollute prototypes', () => {
    const body = JSON.parse(
      `{"schemas":["${USER}"],"userName":"a","__proto__":{"admin":true},"name":{"__proto__":{"x":1}}}`,
    );
    expect(normalizeResourceBody(body, userType, lenient).attributes).toEqual({ userName: 'a' });
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });
});

describe('normalizeAttributes with existing values', () => {
  const type = new CompiledResourceType(
    defineResourceType({
      name: 'User',
      endpoint: '/Users',
      schema: customizeSchema(USER_SCHEMA, {
        add: [
          { name: 'employeeId', mutability: 'immutable' },
          {
            name: 'badge',
            type: 'complex',
            subAttributes: [{ name: 'serial', mutability: 'immutable' }, { name: 'color' }],
          },
        ],
      }),
    }),
  );

  it('carries immutable values over and rejects changes', () => {
    const existing = { userName: 'a', employeeId: 'E1', badge: { serial: 'S1', color: 'red' } };
    expect(
      normalizeAttributes({ userName: 'a', badge: { color: 'blue' } }, type, { ...lenient, existing })
        .attributes,
    ).toEqual({
      userName: 'a',
      employeeId: 'E1',
      badge: { color: 'blue', serial: 'S1' },
    });
    expect(
      error(() => normalizeAttributes({ userName: 'a', employeeId: 'E2' }, type, { ...lenient, existing }))
        .scimType,
    ).toBe('mutability');
    expect(
      error(() =>
        normalizeAttributes({ userName: 'a', badge: { serial: 'S2' } }, type, { ...lenient, existing }),
      ).detail,
    ).toBe('"badge.serial" is immutable.');
  });
});

describe('schema definitions', () => {
  it('rejects invalid definitions', () => {
    expect(() => defineSchema({ id: 'not-a-urn', attributes: [] })).toThrow(/is not a URN/);
    expect(() => defineSchema({ id: 'urn:x:y', attributes: [{ name: '1bad' }] })).toThrow(/Invalid name/);
    expect(() => defineSchema({ id: 'urn:x:y', attributes: [{ name: 'a' }, { name: 'A' }] })).toThrow(
      /Duplicate/,
    );
    expect(() => defineSchema({ id: 'urn:x:y', attributes: [{ name: 'id' }] })).toThrow(/common attribute/);
    expect(() => defineSchema({ id: 'urn:x:y', attributes: [{ name: 'c', type: 'complex' }] })).toThrow(
      /at least one/,
    );
    expect(() =>
      defineSchema({ id: 'urn:x:y', attributes: [{ name: 's', subAttributes: [{ name: 'x' }] }] }),
    ).toThrow(/Only complex attributes/);
    expect(() =>
      defineSchema({
        id: 'urn:x:y',
        attributes: [
          {
            name: 'c',
            type: 'complex',
            subAttributes: [{ name: 'd', type: 'complex', subAttributes: [{ name: 'e' }] }],
          },
        ],
      }),
    ).toThrow(/cannot be nested/);
    expect(() =>
      defineSchema({ id: 'urn:x:y', attributes: [{ name: 'a', type: 'text' as 'string' }] }),
    ).toThrow(/Unknown type/);
    expect(() =>
      defineSchema({ id: 'urn:x:y', attributes: [{ name: 'a', mutability: 'x' as 'readOnly' }] }),
    ).toThrow(/Unknown mutability/);
    expect(() =>
      defineSchema({ id: 'urn:x:y', attributes: [{ name: 'a', returned: 'x' as 'always' }] }),
    ).toThrow(/Unknown returned/);
    expect(() =>
      defineSchema({ id: 'urn:x:y', attributes: [{ name: 'a', uniqueness: 'x' as 'none' }] }),
    ).toThrow(/Unknown uniqueness/);
    expect(() => customizeSchema(USER_SCHEMA, { overrides: { shoeSize: { required: true } } })).toThrow(
      /unknown attribute "shoesize"/,
    );
  });

  it('customizes existing attributes', () => {
    const schema = customizeSchema(USER_SCHEMA, {
      overrides: { displayName: { required: true }, 'name.givenName': { required: true } },
      description: 'Ours',
    });
    expect(schema.attributes.find((a) => a.name === 'displayName')?.required).toBe(true);
    expect(
      schema.attributes.find((a) => a.name === 'name')?.subAttributes?.find((a) => a.name === 'givenName')
        ?.required,
    ).toBe(true);
    expect(schema.description).toBe('Ours');
  });

  it('validates resource types', () => {
    expect(() => defineResourceType({ name: 'bad name', schema: USER_SCHEMA })).toThrow(
      /Invalid resource type name/,
    );
    expect(() => defineResourceType({ name: 'X', endpoint: 'Xs', schema: USER_SCHEMA })).toThrow(
      /one path segment/,
    );
    expect(() => defineResourceType({ name: 'X', endpoint: '/Schemas', schema: USER_SCHEMA })).toThrow(
      /reserved/,
    );
    expect(() => defineResourceType({ name: 'X', schema: USER_SCHEMA, extensions: [USER_SCHEMA] })).toThrow(
      /used twice/,
    );
    expect(defineResourceType({ name: 'Device', schema: USER_SCHEMA }).endpoint).toBe('/Devices');
  });
});
