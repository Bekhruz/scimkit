import { describe, expect, it } from 'vitest';
import { evaluateFilter, parseFilter, ScimError, simpleEquality } from 'scimkit';
import { resolveFilter } from '../../src/filter/resolve.js';
import { barbara, ENTERPRISE, groupType, resolve, userType } from '../support/fixtures.js';

const matches = (text: string, resource = barbara()) => evaluateFilter(resolve(text), resource);

describe('evaluateFilter', () => {
  it.each([
    ['userName eq "BJENSEN@example.com"', true],
    ['userName eq "bjensen"', false],
    ['externalId eq "bjensen"', true],
    ['externalId eq "BJENSEN"', false],
    ['name.familyName co "ense"', true],
    ['name.familyName sw "Jen"', true],
    ['name.familyName ew "SEN"', true],
    ['name.familyName ew "x"', false],
    ['title pr', true],
    ['nickName pr', false],
    ['meta.lastModified gt "2011-05-13T04:42:33Z"', true],
    ['meta.lastModified gt "2011-05-13T04:42:34Z"', false],
    ['meta.lastModified ge "2011-05-13T04:42:34Z"', true],
    ['meta.lastModified lt "2011-05-13T06:42:34+02:00"', false],
    ['meta.lastModified le "2011-05-13T06:42:34+02:00"', true],
    ['meta.created lt "2011-01-01T00:00:00Z"', true],
    ['active eq true', true],
    ['active ne true', false],
    ['nickName ne "x"', true],
    ['userType eq "Employee" and title pr', true],
    ['userType eq "Intern" or title pr', true],
    ['not (userType eq "Employee")', false],
    ['emails eq "babs@jensen.org"', true],
    ['emails.value co "@example.com"', true],
    ['emails.type eq "other"', false],
    ['emails[type eq "work" and value co "@example.com"]', true],
    ['emails[type eq "home" and value co "@example.com"]', false],
    ['emails[not (type eq "work")]', true],
    ['emails pr', true],
    ['ims pr', false],
    ['ims.value ne "x"', false],
    ['groups[value eq "e9e30dba-f08f-4109-8486-d5c6a331660a"]', true],
    ['groups.display eq "tour guides"', true],
    [`${ENTERPRISE}:employeeNumber eq "701984"`, true],
    [`${ENTERPRISE}:manager.value eq "26118915-6090-4610-87e4-49d8ca9f808d"`, true],
    [`${ENTERPRISE}:manager eq "26118915-6090-4610-87e4-49d8ca9f808d"`, true],
    [`${ENTERPRISE}:manager pr`, true],
    ['urn:ietf:params:scim:schemas:core:2.0:User:userName sw "bj"', true],
    ['department eq "Tour Operations"', true],
    ['userName eq null', false],
    ['nickName eq null', true],
    ['userName ne null', true],
    ['name[givenName eq "Barbara"]', true],
    ['meta.resourceType eq "User"', true],
    ['id eq "2819c223-7f76-453a-919d-413861904646"', true],
  ])('%s → %s', (text, expected) => {
    expect(matches(text)).toBe(expected);
  });

  it('compares numbers and booleans by value', () => {
    const resource = { ...barbara(), active: false };
    expect(matches('active eq false', resource)).toBe(true);
    expect(matches('active eq "false"', resource)).toBe(true);
  });

  it('treats empty values as absent for pr', () => {
    expect(matches('title pr', { ...barbara(), title: '' })).toBe(false);
    expect(matches('emails pr', { ...barbara(), emails: [] })).toBe(false);
    expect(matches('name pr', { ...barbara(), name: {} })).toBe(false);
  });

  it('evaluates against group members', () => {
    const group = {
      id: 'g1',
      displayName: 'Admins',
      members: [{ value: 'u1', type: 'User', display: 'Ann' }],
    };
    const run = (text: string) =>
      evaluateFilter(resolveFilter(parseFilter(text), groupType, { lenient: true }), group);
    expect(run('id eq "g1" and members[value eq "u1"]')).toBe(true);
    expect(run('members.value eq "u2"')).toBe(false);
    expect(run('members eq "u1"')).toBe(true);
    expect(run('displayName eq "admins"')).toBe(true);
  });
});

describe('resolveFilter', () => {
  const rejects = (text: string, message: RegExp, lenient = true) => {
    let error: unknown;
    try {
      resolve(text, userType, lenient);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ScimError);
    expect((error as ScimError).scimType).toBe('invalidFilter');
    expect((error as ScimError).detail).toMatch(message);
  };

  it('rejects unknown attributes and schemas', () => {
    rejects('shoeSize eq 9', /Unknown attribute "shoeSize"/);
    rejects('name.nick eq "x"', /Unknown attribute "name.nick"/);
    rejects('userName.first eq "x"', /has no sub-attributes/);
    rejects('urn:example:other:attr eq "x"', /Unknown schema "urn:example:other"/);
    rejects('emails[kind eq "x"]', /Unknown attribute "emails.kind"/);
    rejects('emails[name.x eq "x"]', /use sub-attribute names only/);
    rejects('userName[x eq "y"]', /is not a complex attribute/);
    rejects('department eq "x"', /Unknown attribute "department"/, false);
  });

  it('rejects comparisons the attribute type does not support', () => {
    rejects('active gt true', /Boolean attributes support only eq and ne/);
    rejects('active eq "yes"', /Expected true or false/);
    rejects('active eq "true"', /Expected true or false/, false);
    rejects('meta.created co "2011"', /Date-time attributes do not support co/);
    rejects('meta.created gt "yesterday"', /Expected an xsd:dateTime/);
    rejects('x509Certificates.value gt "AA=="', /Binary attributes do not support gt/);
    rejects('x509Certificates.value eq 1', /Expected a string/);
    rejects('userName eq 5', /Expected a string/, false);
    rejects('name eq "x"', /is complex and cannot be compared/);
    rejects('addresses eq "x"', /is complex and cannot be compared/);
    rejects('userName gt null', /cannot compare with null/);
  });

  it('rejects attributes that cannot be queried', () => {
    rejects('password eq "secret"', /cannot be used in a query/);
    rejects('meta.location pr', /cannot be used in a query/);
    rejects('meta.version eq "W/\\"1\\""', /cannot be used in a query/);
    rejects('groups.$ref pr', /cannot be used in a query/);
  });

  it('coerces literals leniently', () => {
    const filter = resolve('userName eq 42');
    expect(filter).toMatchObject({ type: 'compare', value: '42' });
  });

  it('validates numeric literals against integer and decimal attributes', async () => {
    const { defineResourceType, defineSchema } = await import('scimkit');
    const { CompiledResourceType } = await import('../../src/schema/resource-type.js');
    const type = new CompiledResourceType(
      defineResourceType({
        name: 'Device',
        schema: defineSchema({
          id: 'urn:example:scim:Device',
          attributes: [
            { name: 'ports', type: 'integer' },
            { name: 'weight', type: 'decimal' },
          ],
        }),
      }),
    );
    const run = (text: string, lenient = true) => resolveFilter(parseFilter(text), type, { lenient });
    expect(run('ports gt "3"')).toMatchObject({ value: 3 });
    expect(() => run('ports gt "3"', false)).toThrow(/Expected a number/);
    expect(() => run('ports eq 1.5')).toThrow(/Expected an integer/);
    expect(() => run('weight co 1')).toThrow(/Numeric attributes do not support co/);
    expect(evaluateFilter(run('weight ge 1.5'), { weight: 2 })).toBe(true);
    expect(evaluateFilter(run('weight lt 1.5'), { weight: 'heavy' })).toBe(false);
    expect(evaluateFilter(run('weight ne 1.5'), { weight: 'heavy' })).toBe(true);
  });
});

describe('simpleEquality', () => {
  it('flattens eq conditions joined with and', () => {
    expect(
      simpleEquality(
        resolveFilter(parseFilter('id eq "g" and members[value eq "u"]'), groupType, { lenient: true }),
      ),
    ).toEqual([
      { attribute: 'id', value: 'g', caseExact: true },
      { attribute: 'members.value', value: 'u', caseExact: true },
    ]);
    expect(simpleEquality(resolve(`userName eq "a" and ${ENTERPRISE}:employeeNumber eq "7"`))).toEqual([
      { attribute: 'userName', value: 'a', caseExact: false },
      { attribute: `${ENTERPRISE}:employeeNumber`, value: '7', caseExact: false },
    ]);
    expect(simpleEquality(undefined)).toEqual([]);
  });

  it('returns undefined for other shapes', () => {
    expect(simpleEquality(resolve('userName co "a"'))).toBeUndefined();
    expect(simpleEquality(resolve('userName eq "a" or userName eq "b"'))).toBeUndefined();
    expect(simpleEquality(resolve('userName eq "a" and title pr'))).toBeUndefined();
    expect(simpleEquality(resolve('emails[type eq "work" and value co "x"]'))).toBeUndefined();
  });
});
