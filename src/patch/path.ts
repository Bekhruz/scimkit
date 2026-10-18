import type { ResolvedFilter, ResolvedPath } from '../filter/ast.js';
import { parseAttributePath, parseFilter } from '../filter/parser.js';
import { resolveAttributePath, resolveValueFilter } from '../filter/resolve.js';
import { ScimError } from '../errors.js';
import { findSubAttribute } from '../schema/definitions.js';
import type { CompiledResourceType } from '../schema/resource-type.js';

/** Where a PATCH operation applies (RFC 7644 §3.5.2). */
export type PatchTarget =
  | { readonly kind: 'extension'; readonly schema: string }
  | {
      readonly kind: 'attribute';
      /** The attribute, and a sub-attribute for `name.givenName` or `emails[...].value`. */
      readonly path: ResolvedPath;
      /** The value filter of `emails[type eq "work"]`, relative to one element. */
      readonly filter?: ResolvedFilter;
      readonly text: string;
    };

/**
 * Parses and resolves a PATCH path:
 * `attrPath`, `attrPath[valueFilter]` or `attrPath[valueFilter].subAttr`, each
 * optionally prefixed with a schema URN, or a schema URN alone for a whole
 * extension. Throws a 400 `invalidPath` (or `invalidFilter`) error.
 */
export function parsePatchPath(
  text: string,
  type: CompiledResourceType,
  options: { lenient: boolean },
): PatchTarget {
  const trimmed = text.trim();
  if (trimmed === '') throw ScimError.invalidPath('The path is empty.');
  const bracket = trimmed.indexOf('[');
  let attributeText = trimmed;
  let filterText: string | undefined;
  let after = '';
  if (bracket !== -1) {
    const close = closingBracket(trimmed, bracket);
    attributeText = trimmed.slice(0, bracket);
    filterText = trimmed.slice(bracket + 1, close);
    after = trimmed.slice(close + 1);
    if (after !== '' && !/^\.[A-Za-z$][A-Za-z0-9_$-]*$/.test(after)) {
      throw ScimError.invalidPath(`Invalid path "${text}".`);
    }
  }

  const split = type.splitUrn(attributeText);
  if (split?.rest === '') {
    if (filterText !== undefined)
      throw ScimError.invalidPath(`A schema URN cannot take a value filter ("${text}").`);
    return { kind: 'extension', schema: split.urn };
  }
  const syntax =
    split === undefined
      ? parseAttributePath(attributeText, ScimError.invalidPath)
      : { uri: split.urn, ...parseAttributePath(split.rest, ScimError.invalidPath) };
  let path = resolveAttributePath(syntax, type, options, ScimError.invalidPath);

  if (filterText === undefined) return { kind: 'attribute', path, text: trimmed };

  if (path.subAttribute !== undefined) {
    throw ScimError.invalidPath(`A value filter must follow an attribute, not a sub-attribute ("${text}").`);
  }
  if (path.attribute.type !== 'complex') {
    throw ScimError.invalidPath(`"${path.attribute.name}" is not complex and cannot take a value filter.`);
  }
  const filter = resolveValueFilter(parseFilter(filterText), type, options, path);
  if (after !== '') {
    const sub = findSubAttribute(path.attribute, after.slice(1));
    if (sub === undefined) throw ScimError.invalidPath(`Unknown attribute "${path.attribute.name}${after}".`);
    path = { ...path, subAttribute: sub };
  }
  return { kind: 'attribute', path, filter, text: trimmed };
}

function closingBracket(text: string, open: number): number {
  let inString = false;
  for (let index = open + 1; index < text.length; index++) {
    const char = text.charAt(index);
    if (inString) {
      if (char === '\\') index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === ']') {
      return index;
    }
  }
  throw ScimError.invalidPath(`Missing "]" in path "${text}".`);
}
