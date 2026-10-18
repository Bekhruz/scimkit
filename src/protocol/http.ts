import { ScimError } from '../errors.js';
import type { HeaderValues, QueryValues, ScimLogger } from './types.js';

/** Reads a header case-insensitively; repeated headers are joined with ", ". */
export function header(headers: HeaderValues | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, string | readonly string[] | undefined>,
  )) {
    if (key.toLowerCase() !== lower || value === undefined) continue;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** Query parameters as a map from name to first value. Names are matched case-insensitively when lenient. */
export class QueryParameters {
  private readonly values = new Map<string, string>();

  constructor(
    query: QueryValues | undefined,
    private readonly lenient: boolean,
  ) {
    const add = (key: string, value: string) => {
      const name = lenient ? key.toLowerCase() : key;
      if (!this.values.has(name)) this.values.set(name, value);
    };
    if (query === undefined) return;
    if (typeof query === 'string' || query instanceof URLSearchParams) {
      const params = typeof query === 'string' ? new URLSearchParams(query.replace(/^\?/, '')) : query;
      for (const [key, value] of params) add(key, value);
      return;
    }
    for (const [key, value] of Object.entries(
      query as Record<string, string | readonly string[] | undefined>,
    )) {
      if (value === undefined) continue;
      const first = typeof value === 'string' ? value : value[0];
      if (first !== undefined) add(key, first);
    }
  }

  get(name: string): string | undefined {
    return this.values.get(this.lenient ? name.toLowerCase() : name);
  }
}

/** Parses a request body that may arrive parsed, as text or as bytes. */
export function parseJsonBody(body: unknown): unknown {
  let text: string | undefined;
  if (body === undefined || body === null) text = '';
  else if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else return body;
  if (text.trim() === '') throw ScimError.invalidSyntax('The request needs a JSON body.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ScimError.invalidSyntax('The request body is not valid JSON.');
  }
}

/** The size of a body in bytes, as far as it can be known. */
export function bodySize(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (body instanceof Uint8Array) return body.byteLength;
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).byteLength;
}

/** Whether an If-Match / If-None-Match header value matches a version (weak comparison). */
export function etagMatches(value: string, version: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((tag) =>
      tag
        .trim()
        .replace(/^W\//i, '')
        .replace(/^"(.*)"$/, '$1'),
    )
    .some((tag) => tag === version);
}

/** A logger that writes warnings and errors to the console. */
export const consoleLogger: ScimLogger = {
  debug() {
    // Debug output is opt-in: pass your own logger to see it.
  },
  info() {
    // Info output is opt-in: pass your own logger to see it.
  },
  warn(message, fields) {
    console.warn(`[scimkit] ${message}`, fields ?? '');
  },
  error(message, fields) {
    console.error(`[scimkit] ${message}`, fields ?? '');
  },
};

/** A logger that discards everything. */
export const silentLogger: ScimLogger = {
  debug() {
    // Discarded.
  },
  info() {
    // Discarded.
  },
  warn() {
    // Discarded.
  },
  error() {
    // Discarded.
  },
};
