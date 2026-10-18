import { ScimError } from '../errors.js';
import { ATTRIBUTE_NAME } from '../schema/definitions.js';
import {
  type AttributePathSyntax,
  COMPARE_OPERATORS,
  type CompareOperator,
  type FilterExpression,
  type FilterLiteral,
} from './ast.js';

type Token =
  | { kind: '(' | ')' | '[' | ']'; start: number }
  | { kind: 'word'; text: string; start: number }
  | { kind: 'string'; value: string; start: number }
  | { kind: 'number'; value: number; start: number };

export interface FilterParseLimits {
  /** Longest accepted filter, in characters. Default 4096. */
  maxLength?: number;
  /** Deepest accepted nesting of parentheses, `not` and value filters. Default 32. */
  maxDepth?: number;
  /** Most comparisons accepted in one filter. Default 128. */
  maxComparisons?: number;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z$][A-Za-z0-9_$:.-]*/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '(' || char === ')' || char === '[' || char === ']') {
      tokens.push({ kind: char, start: index });
      index++;
      continue;
    }
    if (char === '"') {
      const end = endOfString(text, index);
      let value: unknown;
      try {
        value = JSON.parse(text.slice(index, end));
      } catch {
        throw ScimError.invalidFilter(`Invalid string at position ${index + 1}.`);
      }
      tokens.push({ kind: 'string', value: value as string, start: index });
      index = end;
      continue;
    }
    NUMBER.lastIndex = index;
    const number = NUMBER.exec(text);
    if (number !== null && (char === '-' || /\d/.test(char))) {
      tokens.push({ kind: 'number', value: Number(number[0]), start: index });
      index += number[0].length;
      continue;
    }
    WORD.lastIndex = index;
    const word = WORD.exec(text);
    if (word !== null) {
      tokens.push({ kind: 'word', text: word[0], start: index });
      index += word[0].length;
      continue;
    }
    throw ScimError.invalidFilter(`Unexpected character "${char}" at position ${index + 1}.`);
  }
  return tokens;
}

function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index++;
  }
  throw ScimError.invalidFilter(`Unterminated string starting at position ${start + 1}.`);
}

/**
 * Splits an attribute path such as `name.givenName` or
 * `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager.value`.
 * Attribute names cannot contain colons, so a URN prefix ends at the last colon.
 */
export function parseAttributePath(text: string, onError = ScimError.invalidFilter): AttributePathSyntax {
  let uri: string | undefined;
  let rest = text;
  if (/^urn:/i.test(text)) {
    const colon = text.lastIndexOf(':');
    uri = text.slice(0, colon);
    rest = text.slice(colon + 1);
  }
  const parts = rest.split('.');
  const [attribute, subAttribute] = parts;
  if (
    parts.length > 2 ||
    attribute === undefined ||
    !ATTRIBUTE_NAME.test(attribute) ||
    (subAttribute !== undefined && !ATTRIBUTE_NAME.test(subAttribute))
  ) {
    throw onError(`Invalid attribute path "${text}".`);
  }
  return {
    ...(uri === undefined ? {} : { uri }),
    attribute,
    ...(subAttribute === undefined ? {} : { subAttribute }),
  };
}

class Parser {
  private position = 0;
  private depth = 0;
  private comparisons = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly maxDepth: number,
    private readonly maxComparisons: number,
  ) {}

  parse(): FilterExpression {
    const expression = this.parseOr(false);
    const token = this.peek();
    if (token !== undefined) throw this.error(token, `Unexpected ${describe(token)}`);
    return expression;
  }

  private parseOr(inValuePath: boolean): FilterExpression {
    let left = this.parseAnd(inValuePath);
    while (this.peekKeyword('or')) {
      this.position++;
      left = { type: 'or', left, right: this.parseAnd(inValuePath) };
    }
    return left;
  }

  private parseAnd(inValuePath: boolean): FilterExpression {
    let left = this.parseUnary(inValuePath);
    while (this.peekKeyword('and')) {
      this.position++;
      left = { type: 'and', left, right: this.parseUnary(inValuePath) };
    }
    return left;
  }

  private parseUnary(inValuePath: boolean): FilterExpression {
    const token = this.peek();
    if (token === undefined) throw this.endError('Expected an expression');
    if (token.kind === 'word' && token.text.toLowerCase() === 'not' && this.peek(1)?.kind === '(') {
      this.position++;
      return { type: 'not', expression: this.parseGroup(inValuePath) };
    }
    if (token.kind === '(') return this.parseGroup(inValuePath);
    if (token.kind !== 'word') throw this.error(token, `Expected an attribute but found ${describe(token)}`);
    return this.parseAttributeExpression(inValuePath);
  }

  private parseGroup(inValuePath: boolean): FilterExpression {
    this.expect('(');
    this.enter();
    const expression = this.parseOr(inValuePath);
    this.depth--;
    this.expect(')');
    return expression;
  }

  private parseAttributeExpression(inValuePath: boolean): FilterExpression {
    const token = this.next() as Extract<Token, { kind: 'word' }>;
    const path = parseAttributePath(token.text, (message) =>
      ScimError.invalidFilter(`${message.slice(0, -1)} at position ${token.start + 1}.`),
    );
    const following = this.peek();
    if (following?.kind === '[') {
      if (inValuePath) throw this.error(following, 'Value filters cannot be nested');
      if (path.subAttribute !== undefined) {
        throw this.error(following, 'A value filter must follow an attribute, not a sub-attribute');
      }
      this.position++;
      this.enter();
      const expression = this.parseOr(true);
      this.depth--;
      this.expect(']');
      return { type: 'valuePath', path, expression };
    }
    if (following === undefined) throw this.endError(`Expected an operator after "${token.text}"`);
    if (following.kind !== 'word')
      throw this.error(following, `Expected an operator but found ${describe(following)}`);
    const operator = following.text.toLowerCase();
    this.position++;
    this.count();
    if (operator === 'pr') return { type: 'present', path };
    if (!COMPARE_OPERATORS.has(operator)) {
      throw this.error(following, `Unknown operator "${following.text}"`);
    }
    return { type: 'compare', path, operator: operator as CompareOperator, value: this.parseValue() };
  }

  private parseValue(): FilterLiteral {
    const token = this.next();
    if (token === undefined) throw this.endError('Expected a value');
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'word') {
      const word = token.text.toLowerCase();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'null') return null;
    }
    throw this.error(token, `Expected a string, number, true, false or null but found ${describe(token)}`);
  }

  private enter(): void {
    this.depth++;
    if (this.depth > this.maxDepth) {
      throw ScimError.invalidFilter(`The filter is nested deeper than ${this.maxDepth} levels.`);
    }
  }

  private count(): void {
    this.comparisons++;
    if (this.comparisons > this.maxComparisons) {
      throw ScimError.invalidFilter(`The filter has more than ${this.maxComparisons} comparisons.`);
    }
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  private peekKeyword(keyword: string): boolean {
    const token = this.peek();
    return token?.kind === 'word' && token.text.toLowerCase() === keyword;
  }

  private next(): Token | undefined {
    const token = this.tokens[this.position];
    this.position++;
    return token;
  }

  private expect(kind: '(' | ')' | ']'): void {
    const token = this.next();
    if (token === undefined) throw this.endError(`Expected "${kind}"`);
    if (token.kind !== kind) throw this.error(token, `Expected "${kind}" but found ${describe(token)}`);
  }

  private error(token: Token, message: string): ScimError {
    return ScimError.invalidFilter(`${message} at position ${token.start + 1}.`);
  }

  private endError(message: string): ScimError {
    return ScimError.invalidFilter(`${message} at the end of the filter.`);
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'word':
      return `"${token.text}"`;
    case 'string':
      return `the string ${JSON.stringify(token.value)}`;
    case 'number':
      return `the number ${token.value}`;
    default:
      return `"${token.kind}"`;
  }
}

/**
 * Parses a SCIM filter (RFC 7644 §3.4.2.2), for example
 * `userName eq "bjensen" and emails[type eq "work" and value co "@example.com"]`.
 * Operators and keywords are case-insensitive. Throws a 400 `invalidFilter`
 * {@link ScimError} that names the position of the problem.
 */
export function parseFilter(text: string, limits: FilterParseLimits = {}): FilterExpression {
  const maxLength = limits.maxLength ?? 4096;
  if (text.length > maxLength)
    throw ScimError.invalidFilter(`The filter is longer than ${maxLength} characters.`);
  if (text.trim() === '') throw ScimError.invalidFilter('The filter is empty.');
  return new Parser(tokenize(text), limits.maxDepth ?? 32, limits.maxComparisons ?? 128).parse();
}

/** Writes a filter expression back as text, in canonical form. */
export function stringifyFilter(expression: FilterExpression): string {
  const path = (value: AttributePathSyntax): string =>
    `${value.uri === undefined ? '' : `${value.uri}:`}${value.attribute}${value.subAttribute === undefined ? '' : `.${value.subAttribute}`}`;
  const wrap = (inner: FilterExpression, parent: 'and' | 'or'): string => {
    const text = stringifyFilter(inner);
    return inner.type === 'or' && parent === 'and' ? `(${text})` : text;
  };
  switch (expression.type) {
    case 'compare':
      return `${path(expression.path)} ${expression.operator} ${JSON.stringify(expression.value)}`;
    case 'present':
      return `${path(expression.path)} pr`;
    case 'and':
    case 'or':
      return `${wrap(expression.left, expression.type)} ${expression.type} ${wrap(expression.right, expression.type)}`;
    case 'not':
      return `not (${stringifyFilter(expression.expression)})`;
    case 'valuePath':
      return `${path(expression.path)}[${stringifyFilter(expression.expression)}]`;
  }
}
