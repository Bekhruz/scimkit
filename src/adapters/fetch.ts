import { isScimError, ScimError } from '../errors.js';
import type { ScimServer } from '../protocol/server.js';
import type { ScimHttpResponse } from '../protocol/types.js';
import { normalizeBasePath, stripBasePath } from './node.js';

export interface FetchHandlerOptions {
  /** The path the SCIM root is served at, such as `/scim/v2`. */
  basePath?: string;
  /** Largest accepted request body in bytes. Default 5 MiB. */
  bodyLimit?: number;
}

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/**
 * Serves a ScimServer with the Fetch API: `(request: Request) => Promise<Response>`.
 * Works with Hono, Bun.serve, Deno.serve, Next.js route handlers and other
 * runtimes built on Request and Response.
 */
export function createFetchHandler(
  server: ScimServer,
  options: FetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const basePath = normalizeBasePath(options.basePath);
  const bodyLimit = options.bodyLimit ?? 5 * 1024 * 1024;
  return async (request) => {
    const url = new URL(request.url);
    const relative = stripBasePath(url.pathname, basePath);
    if (relative === undefined)
      return toResponse(errorResult(ScimError.notFound(`No SCIM resource at ${url.pathname}.`)));
    let body: string | undefined;
    if (!BODYLESS.has(request.method.toUpperCase())) {
      try {
        body = await readText(request, bodyLimit);
      } catch (error) {
        return toResponse(errorResult(error));
      }
    }
    const result = await server.handle({
      method: request.method,
      path: relative,
      query: url.searchParams,
      headers: request.headers,
      body,
      baseUrl: `${url.origin}${basePath}`,
      signal: request.signal,
    });
    return toResponse(result);
  };
}

async function readText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw ScimError.payloadTooLarge(`The request body is larger than ${limit} bytes.`);
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw ScimError.payloadTooLarge(`The request body is larger than ${limit} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function errorResult(error: unknown): ScimHttpResponse {
  const scim = isScimError(error) ? error : ScimError.internal();
  return {
    status: scim.status,
    headers: { 'Content-Type': 'application/scim+json; charset=utf-8', ...scim.headers },
    body: scim.toJSON(),
  };
}

function toResponse(result: ScimHttpResponse): Response {
  return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}
