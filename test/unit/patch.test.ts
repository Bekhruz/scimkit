import { describe, expect, it } from 'vitest';
import { type JsonObject, SCIM_MESSAGES, ScimError } from 'scimkit';
import { applyPatch, parsePatchBody } from '../../src/patch/apply.js';
import { parsePatchPath } from '../../src/patch/path.js';
import { normalizeAttributes } from '../../src/resource/normalize.js';
import type { CompiledResourceType } from '../../src/schema/resource-type.js';
import { ENTERPRISE, groupType, userType } from '../support/fixtures.js';

interface Options {
  type?: CompiledResourceType;
  lenient?: boolean;
  id?: string;
}

function patch(attributes: JsonObject, operations: unknown[], options: Options = {}): JsonObject {
  const lenient = options.lenient ?? true;
  const parsed = parsePatchBody(
    { schemas: [SCIM_MESSAGES.patchOp], Operations: operations },
    { lenient, maxOperations: 100 },
  );
  return applyPatch(attributes, parsed, options.type ?? userType, {
    lenient,
    resourceId: options.id ?? 'self',
  });
}

function failure(run: () => unknown): ScimError {
  try {
    run();
  } catch (caught) {
    if (caught instanceof ScimError) return caught;
    throw caught;
  }
  throw new Error('Expected a ScimError');
}

const group = (): JsonObject => ({
  displayName: 'Tour Guides',
  members: [
    { value: 'u1', type: 'User', display: 'Ann' },
    { value: 'u2', type: 'User', display: 'Bo' },
  ],
});

const user = (): JsonObject => ({
  userName: 'bjensen',
  name: { givenName: 'Barbara', familyName: 'Jensen' },
  active: true,
  emails: [
    { value: 'bjensen@example.com', type: 'work', primary: true },
    { value: 'babs@jensen.org', type: 'home' },
  ],
  addresses: [{ type: 'work', streetAddress: '100 Universal City Plaza', locality: 'Hollywood' }],
  [ENTERPRISE]: { department: 'Tours', manager: { value: 'm1' } },
});

describe('PATCH add (RFC 7644 §3.5.2.1)', () => {
  it('adds members, ignoring read-only display and server-computed $ref', () => {
    const result = patch(
      group(),
      [{ op: 'add', path: 'members', value: [{ display: 'Cy', $ref: 'https://x/Users/u3', value: 'u3' }] }],
      { type: groupType },
    );
    expect(result['members']).toEqual([
      { value: 'u1', type: 'User', display: 'Ann' },
      { value: 'u2', type: 'User', display: 'Bo' },
      { value: 'u3' },
    ]);
  });

  it('does not duplicate a member that is already there', () => {
    const result = patch(group(), [{ op: 'add', path: 'members', value: [{ value: 'u1' }] }], {
      type: groupType,
    });
    expect(result['members']).toHaveLength(2);
  });

  it('adds attributes without a path', () => {
    const result = patch(user(), [
      { op: 'add', value: { emails: [{ value: 'babs@example.org', type: 'other' }], nickname: 'Babs' } },
    ]);
    expect(result['nickName']).toBe('Babs');
    expect(result['emails']).toHaveLength(3);
  });

  it('merges complex values and sets simple ones', () => {
    const result = patch(user(), [
      { op: 'add', path: 'name', value: { middleName: 'J' } },
      { op: 'add', path: 'title', value: 'Guide' },
      { op: 'add', path: 'name.honorificSuffix', value: 'III' },
    ]);
    expect(result['name']).toEqual({
      givenName: 'Barbara',
      familyName: 'Jensen',
      middleName: 'J',
      honorificSuffix: 'III',
    });
    expect(result['title']).toBe('Guide');
  });

  it('makes a newly added primary value the only primary one', () => {
    const result = patch(user(), [
      { op: 'add', path: 'emails', value: [{ value: 'new@example.com', primary: true }] },
    ]);
    expect((result['emails'] as JsonObject[]).map((email) => email['primary'])).toEqual([
      false,
      undefined,
      true,
    ]);
  });

  it('adds to a whole extension', () => {
    const result = patch(user(), [{ op: 'add', path: ENTERPRISE, value: { costCenter: '42' } }]);
    expect(result[ENTERPRISE]).toEqual({ department: 'Tours', manager: { value: 'm1' }, costCenter: '42' });
  });

  it('ignores an added null', () => {
    expect(patch(user(), [{ op: 'add', path: 'title', value: null }])['title']).toBeUndefined();
  });
});

describe('PATCH replace (RFC 7644 §3.5.2.3)', () => {
  it('replaces all members', () => {
    const result = patch(group(), [{ op: 'replace', path: 'members', value: [{ value: 'u9' }] }], {
      type: groupType,
    });
    expect(result['members']).toEqual([{ value: 'u9' }]);
  });

  it('replaces values selected by a filter, keeping sub-attributes not given', () => {
    const result = patch(user(), [
      {
        op: 'replace',
        path: 'addresses[type eq "work"]',
        value: { streetAddress: '911 Universal City Plaza' },
      },
    ]);
    expect(result['addresses']).toEqual([
      { type: 'work', streetAddress: '911 Universal City Plaza', locality: 'Hollywood' },
    ]);
  });

  it('replaces a sub-attribute of filtered values', () => {
    const result = patch(user(), [
      { op: 'replace', path: 'addresses[type eq "work"].streetAddress', value: '1010 Broadway Ave' },
    ]);
    expect((result['addresses'] as JsonObject[])[0]?.['streetAddress']).toBe('1010 Broadway Ave');
  });

  it('replaces attributes without a path', () => {
    const result = patch(user(), [
      { op: 'replace', value: { emails: [{ value: 'only@example.com', type: 'work' }], nickName: 'Babs' } },
    ]);
    expect(result['emails']).toEqual([{ value: 'only@example.com', type: 'work' }]);
    expect(result['nickName']).toBe('Babs');
  });

  it('removes an attribute replaced with null', () => {
    expect(patch(user(), [{ op: 'replace', path: 'name', value: null }])['name']).toBeUndefined();
    expect(patch(user(), [{ op: 'replace', path: ENTERPRISE, value: null }])[ENTERPRISE]).toBeUndefined();
  });

  it('sets the primary value of a multi-valued sub-attribute without a filter', () => {
    const result = patch(user(), [{ op: 'replace', path: 'emails.value', value: 'primary@example.com' }]);
    expect((result['emails'] as JsonObject[])[0]?.['value']).toBe('primary@example.com');
    const single = patch({ userName: 'a', emails: [{ value: 'x@y' }] }, [
      { op: 'replace', path: 'emails.value', value: 'z@y' },
    ]);
    expect(single['emails']).toEqual([{ value: 'z@y' }]);
    const empty = patch({ userName: 'a' }, [{ op: 'replace', path: 'emails.value', value: 'z@y' }]);
    expect(empty['emails']).toEqual([{ value: 'z@y' }]);
    const ambiguous = { userName: 'a', emails: [{ value: 'x@y' }, { value: 'w@y' }] };
    expect(
      failure(() => patch(ambiguous, [{ op: 'replace', path: 'emails.value', value: 'z' }])).scimType,
    ).toBe('noTarget');
  });

  it('moves primary to the value it is set on', () => {
    const result = patch(user(), [{ op: 'replace', path: 'emails[type eq "home"].primary', value: true }]);
    expect((result['emails'] as JsonObject[]).map((email) => email['primary'])).toEqual([false, true]);
    const merged = patch(user(), [
      { op: 'replace', path: 'emails[type eq "home"]', value: { primary: true } },
    ]);
    expect((merged['emails'] as JsonObject[]).map((email) => email['primary'])).toEqual([false, true]);
  });
});

describe('PATCH remove (RFC 7644 §3.5.2.2)', () => {
  it('removes one member', () => {
    const result = patch(group(), [{ op: 'remove', path: 'members[value eq "u1"]' }], { type: groupType });
    expect(result['members']).toEqual([{ value: 'u2', type: 'User', display: 'Bo' }]);
  });

  it('removes all members', () => {
    expect(
      patch(group(), [{ op: 'remove', path: 'members' }], { type: groupType })['members'],
    ).toBeUndefined();
  });

  it('removes and adds in one request', () => {
    const result = patch(
      group(),
      [
        { op: 'remove', path: 'members[value eq "u1"]' },
        { op: 'add', path: 'members', value: [{ value: 'u3' }] },
      ],
      { type: groupType },
    );
    expect((result['members'] as JsonObject[]).map((member) => member['value'])).toEqual(['u2', 'u3']);
  });

  it('removes values matched by a complex filter', () => {
    const result = patch(user(), [
      { op: 'remove', path: 'emails[type eq "work" and value ew "example.com"]' },
    ]);
    expect(result['emails']).toEqual([{ value: 'babs@jensen.org', type: 'home' }]);
  });

  it('removes sub-attributes', () => {
    expect(patch(user(), [{ op: 'remove', path: 'name.givenName' }])['name']).toEqual({
      familyName: 'Jensen',
    });
    expect(patch(user(), [{ op: 'remove', path: 'emails[type eq "home"].type' }])['emails']).toEqual([
      { value: 'bjensen@example.com', type: 'work', primary: true },
      { value: 'babs@jensen.org' },
    ]);
    expect(patch(user(), [{ op: 'remove', path: 'emails.type' }])['emails']).toEqual([
      { value: 'bjensen@example.com', primary: true },
      { value: 'babs@jensen.org' },
    ]);
    expect(
      patch({ userName: 'a', name: { givenName: 'A' } }, [{ op: 'remove', path: 'name.givenName' }])['name'],
    ).toBeUndefined();
  });

  it('removes extension attributes and whole extensions', () => {
    expect(patch(user(), [{ op: 'remove', path: `${ENTERPRISE}:manager` }])[ENTERPRISE]).toEqual({
      department: 'Tours',
    });
    expect(patch(user(), [{ op: 'remove', path: ENTERPRISE }])[ENTERPRISE]).toBeUndefined();
    const emptied = patch({ userName: 'a', [ENTERPRISE]: { department: 'x' } }, [
      { op: 'remove', path: `${ENTERPRISE}:department` },
    ]);
    expect(emptied[ENTERPRISE]).toBeUndefined();
    expect(patch({ userName: 'a' }, [{ op: 'remove', path: `${ENTERPRISE}:department` }])).toEqual({
      userName: 'a',
    });
  });

  it('is a no-op when a lenient filter matches nothing, and an error when strict', () => {
    expect(
      patch(group(), [{ op: 'remove', path: 'members[value eq "nobody"]' }], { type: groupType })['members'],
    ).toHaveLength(2);
    expect(
      failure(() =>
        patch(group(), [{ op: 'remove', path: 'members[value eq "nobody"]' }], {
          type: groupType,
          lenient: false,
        }),
      ).scimType,
    ).toBe('noTarget');
  });

  it('needs a path', () => {
    expect(failure(() => patch(user(), [{ op: 'remove' }])).scimType).toBe('noTarget');
  });
});

describe('Okta request shapes', () => {
  it('deactivates a user with a path-less replace', () => {
    expect(patch(user(), [{ op: 'replace', value: { active: false } }])['active']).toBe(false);
  });

  it('renames a group with a value that repeats the id', () => {
    const result = patch(group(), [{ op: 'replace', value: { id: 'g1', displayName: 'Test SCIMv2' } }], {
      type: groupType,
      id: 'g1',
      lenient: false,
    });
    expect(result['displayName']).toBe('Test SCIMv2');
  });
});

describe('Microsoft Entra ID request shapes', () => {
  it('accepts capitalised operations and string booleans', () => {
    expect(patch(user(), [{ op: 'Replace', path: 'active', value: 'False' }])['active']).toBe(false);
  });

  it('updates a filtered value and creates it when missing', () => {
    const result = patch(user(), [
      { op: 'Replace', path: 'emails[type eq "work"].value', value: 'updated@example.com' },
      { op: 'Add', path: 'phoneNumbers[type eq "mobile"].value', value: '+1 555 0100' },
      { op: 'Replace', path: 'addresses[type eq "home"].locality', value: 'Burbank' },
    ]);
    expect((result['emails'] as JsonObject[])[0]?.['value']).toBe('updated@example.com');
    expect(result['phoneNumbers']).toEqual([{ type: 'mobile', value: '+1 555 0100' }]);
    expect(result['addresses']).toContainEqual({ type: 'home', locality: 'Burbank' });
  });

  it('creates a whole filtered value when missing', () => {
    const result = patch(user(), [
      { op: 'Add', path: 'addresses[type eq "home" and primary eq false]', value: { locality: 'Burbank' } },
    ]);
    expect(result['addresses']).toContainEqual({ type: 'home', primary: false, locality: 'Burbank' });
    expect(
      failure(() => patch(user(), [{ op: 'Add', path: 'addresses[type co "ho"]', value: { locality: 'x' } }]))
        .scimType,
    ).toBe('noTarget');
    expect(
      failure(() =>
        patch(user(), [{ op: 'Add', path: 'phoneNumbers[type eq "mobile"].value', value: '1' }], {
          lenient: false,
        }),
      ).scimType,
    ).toBe('noTarget');
  });

  it('sets the manager from a bare id and removes it', () => {
    const set = patch({ userName: 'a' }, [{ op: 'Add', path: `${ENTERPRISE}:manager`, value: 'm2' }]);
    expect(set[ENTERPRISE]).toEqual({ manager: { value: 'm2' } });
    expect(patch(set, [{ op: 'Remove', path: `${ENTERPRISE}:manager` }])[ENTERPRISE]).toBeUndefined();
  });

  it('removes only the members listed in the value', () => {
    const result = patch(group(), [{ op: 'Remove', path: 'members', value: [{ $ref: null, value: 'u1' }] }], {
      type: groupType,
    });
    expect(result['members']).toEqual([{ value: 'u2', type: 'User', display: 'Bo' }]);
  });

  it('adds members with a null $ref', () => {
    const result = patch(group(), [{ op: 'Add', path: 'members', value: [{ $ref: null, value: 'u3' }] }], {
      type: groupType,
    });
    expect(result['members']).toContainEqual({ value: 'u3' });
  });

  it('accepts flattened paths inside a path-less value', () => {
    const result = patch(user(), [
      {
        op: 'Replace',
        value: { 'name.givenName': 'Babs', [`${ENTERPRISE}:department`]: 'Sales', schemas: ['x'] },
      },
    ]);
    expect(result['name']).toEqual({ givenName: 'Babs', familyName: 'Jensen' });
    expect(result[ENTERPRISE]).toMatchObject({ department: 'Sales' });
  });

  it('accepts an extension object inside a path-less value', () => {
    const result = patch(user(), [{ op: 'Replace', value: { [ENTERPRISE]: { department: 'Sales' } } }]);
    expect(result[ENTERPRISE]).toMatchObject({ department: 'Sales', manager: { value: 'm1' } });
  });
});

describe('PATCH errors', () => {
  it('rejects read-only targets', () => {
    expect(
      failure(() => patch(user(), [{ op: 'add', path: 'groups', value: [{ value: 'g' }] }])).scimType,
    ).toBe('mutability');
    expect(failure(() => patch(user(), [{ op: 'replace', path: 'id', value: 'other' }])).scimType).toBe(
      'mutability',
    );
    expect(failure(() => patch(user(), [{ op: 'replace', path: 'meta.created', value: 'x' }])).scimType).toBe(
      'mutability',
    );
    expect(
      failure(() =>
        patch(user(), [{ op: 'replace', value: { groups: [{ value: 'g' }] } }], { lenient: false }),
      ).scimType,
    ).toBe('mutability');
    expect(
      patch(user(), [{ op: 'replace', value: { groups: [{ value: 'g' }], meta: {} } }])['groups'],
    ).toBeUndefined();
  });

  it('rejects changes to immutable sub-attributes', () => {
    expect(
      failure(() =>
        patch(group(), [{ op: 'replace', path: 'members[value eq "u1"].value', value: 'u9' }], {
          type: groupType,
        }),
      ).scimType,
    ).toBe('mutability');
    expect(
      failure(() =>
        patch(group(), [{ op: 'remove', path: 'members[value eq "u1"].type' }], { type: groupType }),
      ).scimType,
    ).toBe('mutability');
    expect(
      patch(group(), [{ op: 'replace', path: 'members[value eq "u1"].value', value: 'u1' }], {
        type: groupType,
      })['members'],
    ).toHaveLength(2);
  });

  it('rejects unknown attributes in a path in both modes', () => {
    expect(failure(() => patch(user(), [{ op: 'add', path: 'shoeSize', value: 9 }])).scimType).toBe(
      'invalidPath',
    );
    expect(
      failure(() => patch(user(), [{ op: 'add', value: { shoeSize: 9 } }], { lenient: false })).scimType,
    ).toBe('invalidPath');
    expect(patch(user(), [{ op: 'add', value: { shoeSize: 9 } }])['shoeSize']).toBeUndefined();
  });

  it('rejects bad values with the attribute name', () => {
    expect(failure(() => patch(user(), [{ op: 'replace', path: 'active', value: 'maybe' }])).detail).toBe(
      '"active" must be true or false.',
    );
    expect(failure(() => patch(user(), [{ op: 'add', value: 'x' }])).detail).toMatch(
      /must be an object of attributes/,
    );
    expect(failure(() => patch(user(), [{ op: 'add', path: ENTERPRISE, value: 'x' }])).detail).toMatch(
      /must be an object/,
    );
  });

  it('applies all operations or none', () => {
    const original = user();
    expect(() =>
      patch(original, [
        { op: 'replace', path: 'title', value: 'Changed' },
        { op: 'replace', path: 'shoeSize', value: 1 },
      ]),
    ).toThrow(ScimError);
    expect(original['title']).toBeUndefined();
  });

  it('validates the request envelope', () => {
    const parse = (body: unknown, lenient = true) => parsePatchBody(body, { lenient, maxOperations: 2 });
    expect(failure(() => parse('x')).scimType).toBe('invalidSyntax');
    expect(failure(() => parse({ Operations: [] }, false)).detail).toMatch(/must include/);
    expect(failure(() => parse({ Operations: [] })).detail).toMatch(/non-empty array/);
    expect(failure(() => parse({ Operations: [{ op: 'move', path: 'x' }] })).detail).toMatch(/unknown "op"/);
    expect(failure(() => parse({ Operations: ['x'] })).detail).toMatch(/must be an object/);
    expect(failure(() => parse({ Operations: [{ op: 'add', path: 'x' }] })).detail).toMatch(
      /needs a "value"/,
    );
    expect(failure(() => parse({ Operations: [{ op: 'add', path: 1, value: 1 }] })).scimType).toBe(
      'invalidPath',
    );
    expect(failure(() => parse({ Operations: [{}, {}, {}] })).status).toBe(413);
    expect(parse({ operations: [{ Op: 'Add', Path: 'title', Value: 'x' }] })).toEqual([
      { op: 'add', path: 'title', value: 'x' },
    ]);
    expect(
      failure(() =>
        parse({ schemas: [SCIM_MESSAGES.patchOp], operations: [{ op: 'add', value: {} }] }, false),
      ).detail,
    ).toMatch(/non-empty array/);
    expect(parse({ Operations: [{ op: 'remove', path: '  ' }] })).toEqual([{ op: 'remove' }]);
  });

  it('enforces required attributes on the result', () => {
    const result = patch(user(), [{ op: 'remove', path: 'userName' }]);
    expect(() => normalizeAttributes(result, userType, { lenient: true })).toThrow('"userName" is required.');
  });
});

describe('parsePatchPath', () => {
  const parse = (text: string) => parsePatchPath(text, userType, { lenient: true });

  it('resolves every path form', () => {
    expect(parse('name.givenName')).toMatchObject({
      kind: 'attribute',
      path: { attribute: { name: 'name' }, subAttribute: { name: 'givenName' } },
    });
    expect(parse('emails[type eq "work"].value')).toMatchObject({
      path: { subAttribute: { name: 'value' } },
      filter: { type: 'compare' },
    });
    expect(parse(`${ENTERPRISE}:manager.value`)).toMatchObject({
      path: { extension: true, schema: ENTERPRISE },
    });
    expect(parse(ENTERPRISE.toUpperCase())).toEqual({ kind: 'extension', schema: ENTERPRISE });
    expect(parse('urn:ietf:params:scim:schemas:core:2.0:User:userName')).toMatchObject({
      path: { attribute: { name: 'userName' } },
    });
    expect(parse('emails[value eq "a]b"]')).toMatchObject({ filter: { value: 'a]b' } });
  });

  it.each([
    ['', /empty/],
    ['emails[type eq "work"', /Missing "]"/],
    ['emails[type eq "work"]x', /Invalid path/],
    ['emails[type eq "work"].nope', /Unknown attribute "emails.nope"/],
    [`${ENTERPRISE}[x eq "y"]`, /cannot take a value filter/],
    ['name.givenName[x eq "y"]', /must follow an attribute/],
    ['userName[x eq "y"]', /not complex/],
    ['a.b.c', /Invalid attribute path/],
  ])('rejects %j', (text, message) => {
    expect(() => parse(text)).toThrow(message);
  });
});
