import type { CheckResponse } from './client.js';
import { CheckFailure } from './runner.js';

export type Json = Record<string, unknown>;

export function fail(message: string): never {
  throw new CheckFailure(message);
}

function describe(response: CheckResponse): string {
  const body = response.body as Json | undefined;
  const detail = typeof body?.['detail'] === 'string' ? `: ${body['detail']}` : '';
  const scimType = typeof body?.['scimType'] === 'string' ? ` (${body['scimType']})` : '';
  return `HTTP ${response.status}${scimType}${detail}`;
}

/** Fails unless the response has one of the statuses. */
export function expectStatus(response: CheckResponse, ...statuses: number[]): void {
  if (!statuses.includes(response.status)) {
    fail(`expected HTTP ${statuses.join(' or ')}, got ${describe(response)}`);
  }
}

/** The response body as an object; fails otherwise. */
export function bodyOf(response: CheckResponse): Json {
  const body = response.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(`expected a JSON object body, got ${body === undefined ? 'no body' : typeof body}`);
  }
  return body as Json;
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function expectTrue(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** A ListResponse's resources, after checking its shape. */
export function listOf(response: CheckResponse): Json[] {
  const body = bodyOf(response);
  const schemas = body['schemas'];
  if (!Array.isArray(schemas) || !schemas.includes('urn:ietf:params:scim:api:messages:2.0:ListResponse')) {
    fail('the list response does not declare the ListResponse schema');
  }
  if (typeof body['totalResults'] !== 'number') fail('the list response has no numeric totalResults');
  const resources = body['Resources'];
  if (resources === undefined) {
    if (body['totalResults'] !== 0) fail('the list response has totalResults but no Resources');
    return [];
  }
  if (!Array.isArray(resources)) fail('Resources is not an array');
  return resources as Json[];
}

export function stringField(object: Json, name: string, what = name): string {
  const value = object[name];
  if (typeof value !== 'string' || value === '') fail(`${what} is missing or not a string`);
  return value;
}

/** The ids of the values of a multi-valued attribute such as members. */
export function valuesOf(object: Json | undefined, attribute: string): string[] {
  const list = object?.[attribute];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) =>
    typeof item === 'object' && item !== null && typeof (item as Json)['value'] === 'string'
      ? [(item as Json)['value'] as string]
      : [],
  );
}
