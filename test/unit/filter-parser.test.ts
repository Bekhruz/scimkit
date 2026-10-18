import { describe, expect, it } from 'vitest';
import { parseFilter, ScimError, stringifyFilter } from 'scimkit';

describe('parseFilter', () => {
  // Every example filter from RFC 7644 §3.4.2.2.
  const rfcExamples = [
    'userName eq "bjensen"',
    'name.familyName co "O\'Malley"',
    'userName sw "J"',
    'urn:ietf:params:scim:schemas:core:2.0:User:userName sw "J"',
    'title pr',
    'meta.lastModified gt "2011-05-13T04:42:34Z"',
    'meta.lastModified ge "2011-05-13T04:42:34Z"',
    'meta.lastModified lt "2011-05-13T04:42:34Z"',
    'meta.lastModified le "2011-05-13T04:42:34Z"',
    'title pr and userType eq "Employee"',
    'title pr or userType eq "Intern"',
    'schemas eq "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"',
    'userType eq "Employee" and (emails co "example.com" or emails.value co "example.org")',
    'userType ne "Employee" and not (emails co "example.com" or emails.value co "example.org")',
    'userType eq "Employee" and (emails.type eq "work")',
    'userType eq "Employee" and emails[type eq "work" and value co "@example.com"]',
    'emails[type eq "work" and value co "@example.com"] or ims[type eq "xmpp" and value co "@foo.com"]',
  ];

  it.each(rfcExamples)('parses %s', (text) => {
    expect(() => parseFilter(text)).not.toThrow();
  });

  it('builds the expected tree for comparisons, presence and value paths', () => {
    expect(parseFilter('userName eq "bjensen"')).toEqual({
      type: 'compare',
      path: { attribute: 'userName' },
      operator: 'eq',
      value: 'bjensen',
    });
    expect(parseFilter('title pr')).toEqual({ type: 'present', path: { attribute: 'title' } });
    expect(
      parseFilter('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager.value eq "1"'),
    ).toEqual({
      type: 'compare',
      path: {
        uri: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
        attribute: 'manager',
        subAttribute: 'value',
      },
      operator: 'eq',
      value: '1',
    });
    expect(parseFilter('emails[type eq "work"]')).toEqual({
      type: 'valuePath',
      path: { attribute: 'emails' },
      expression: { type: 'compare', path: { attribute: 'type' }, operator: 'eq', value: 'work' },
    });
  });

  it('gives not higher precedence than and, and and higher than or', () => {
    const tree = parseFilter('a pr or b pr and not (c pr)');
    expect(tree).toEqual({
      type: 'or',
      left: { type: 'present', path: { attribute: 'a' } },
      right: {
        type: 'and',
        left: { type: 'present', path: { attribute: 'b' } },
        right: { type: 'not', expression: { type: 'present', path: { attribute: 'c' } } },
      },
    });
  });

  it('accepts operators and keywords in any case', () => {
    expect(parseFilter('userName EQ "x" AND active Eq TRUE')).toEqual({
      type: 'and',
      left: { type: 'compare', path: { attribute: 'userName' }, operator: 'eq', value: 'x' },
      right: { type: 'compare', path: { attribute: 'active' }, operator: 'eq', value: true },
    });
  });

  it('parses JSON string escapes, numbers, booleans and null', () => {
    const value = (text: string) => {
      const tree = parseFilter(`x eq ${text}`);
      return tree.type === 'compare' ? tree.value : undefined;
    };
    expect(value('"a \\"quoted\\" \\\\ \\u00e9"')).toBe('a "quoted" \\ é');
    expect(value('-12.5e2')).toBe(-1250);
    expect(value('0')).toBe(0);
    expect(value('false')).toBe(false);
    expect(value('null')).toBeNull();
  });

  it('tolerates extra whitespace', () => {
    expect(() => parseFilter('  ( userName   eq "a" )\tor\nuserName eq "b" ')).not.toThrow();
  });

  const invalid: [string, RegExp][] = [
    ['', /empty/],
    ['userName', /Expected an operator after "userName" at the end/],
    ['userName eq', /Expected a value at the end/],
    [
      'userName eq bjensen',
      /Expected a string, number, true, false or null but found "bjensen" at position 13/,
    ],
    ['userName xx "a"', /Unknown operator "xx" at position 10/],
    ['(userName eq "a"', /Expected "\)" at the end/],
    ['userName eq "a")', /Unexpected "\)" at position 16/],
    ['userName eq "a" and', /Expected an expression at the end/],
    ['emails[type eq "work"', /Expected "]" at the end/],
    ['emails[ims[type eq "x"]]', /Value filters cannot be nested at position 11/],
    ['name.givenName[x eq "y"]', /must follow an attribute, not a sub-attribute/],
    ['userName eq "unterminated', /Unterminated string/],
    ['userName eq "bad \\x escape"', /Invalid string/],
    ['a.b.c eq "x"', /Invalid attribute path "a.b.c"/],
    ['userName eq "a" # comment', /Unexpected character "#"/],
    ['eq eq', /Expected a value at the end/],
    ['"x" eq "y"', /Expected an attribute but found the string "x" at position 1/],
    ['userName eq "a" userName eq "b"', /Unexpected "userName" at position 17/],
    ['userName eq (', /Expected a string, number, true, false or null but found "\(" at position 13/],
    ['userName (', /Expected an operator but found "\("/],
  ];

  it.each(invalid)('rejects %j', (text, message) => {
    let error: unknown;
    try {
      parseFilter(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ScimError);
    expect((error as ScimError).status).toBe(400);
    expect((error as ScimError).scimType).toBe('invalidFilter');
    expect((error as ScimError).detail).toMatch(message);
  });

  it('enforces length, depth and size limits', () => {
    expect(() => parseFilter(`userName eq "${'a'.repeat(5000)}"`)).toThrow(/longer than 4096/);
    expect(() => parseFilter(`${'('.repeat(40)}a pr${')'.repeat(40)}`)).toThrow(/deeper than 32/);
    expect(() => parseFilter(Array.from({ length: 200 }, (_, i) => `a${i} pr`).join(' or '))).toThrow(
      /more than 128 comparisons/,
    );
    expect(() => parseFilter('a pr or b pr', { maxComparisons: 1 })).toThrow(/more than 1 comparisons/);
    expect(() => parseFilter('((a pr))', { maxDepth: 1 })).toThrow(/deeper than 1/);
    expect(() => parseFilter('a pr', { maxLength: 2 })).toThrow(/longer than 2/);
  });

  it('writes filters back in canonical form', () => {
    expect(stringifyFilter(parseFilter('userName EQ "a" and (title pr or not (active eq false))'))).toBe(
      'userName eq "a" and (title pr or not (active eq false))',
    );
    expect(stringifyFilter(parseFilter('emails[type eq "work"] or x lt 3'))).toBe(
      'emails[type eq "work"] or x lt 3',
    );
    expect(stringifyFilter(parseFilter('urn:a:b:c:attr.sub sw "q"'))).toBe('urn:a:b:c:attr.sub sw "q"');
  });
});
