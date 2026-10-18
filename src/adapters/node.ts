import type { IncomingMessage, ServerResponse } from 'node:http';
import { isScimError, ScimError } from '../errors.js';
import type { ScimServer } from '../protocol/server.js';
import type { ScimHttpResponse } from '../protocol/types.js';

export interface NodeHandlerOptions {
  /**
   * The path the SCIM root is served at, such as `/scim/v2`. Leave it out when
   * the handler is mounted with `app.use('/scim/v2', handler)` in Express.
   */
  basePath?: string;
  /** Largest accepted request body in bytes. Default 5 MiB. */
  bodyLimit?: number;
  /** Derive the base URL from X-Forwarded-Proto and X-Forwarded-Host. Default false. */
  trustProxy?: boolean;
}

type NodeRequest = IncomingMessage & { body?: unknown; baseUrl?: string };
type Next = (error?: unknown) => void;

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/**
 * Serves a ScimServer from Node's `http` module, Express or any Connect-style
 * framework. Outside `basePath` it calls `next()` when there is one and
 * answers 404 otherwise.
 */
export function createNodeHandler(
  server: ScimServer,
  options: NodeHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse, next?: Next) => void {
  const basePath = normalizeBasePath(options.basePath);
  const bodyLimit = options.bodyLimit ?? 5 * 1024 * 1024;
  return (request, response, next) => {
    void (async () => {
      const req = request as NodeRequest;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const relative = stripBasePath(url.pathname, basePath);
      if (relative === undefined) {
        if (next !== undefined) {
          next();
          return;
        }
        send(response, errorResult(ScimError.notFound(`No SCIM resource at ${url.pathname}.`)));
        return;
      }
      const controller = new AbortController();
      response.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      let body: unknown;
      try {
        body = BODYLESS.has((req.method ?? 'GET').toUpperCase()) ? undefined : await readBody(req, bodyLimit);
      } catch (error) {
        send(response, errorResult(error));
        return;
      }
      const result = await server.handle({
        method: req.method ?? 'GET',
        path: relative,
        query: url.searchParams,
        headers: req.headers,
        body,
        baseUrl: baseUrlOf(req, basePath, options.trustProxy ?? false),
        signal: controller.signal,
      });
      send(response, result);
    })().catch((error: unknown) => {
      if (next !== undefined) next(error);
      else if (!response.headersSent) send(response, errorResult(ScimError.internal()));
      else response.destroy(error instanceof Error ? error : undefined);
    });
  };
}

export function normalizeBasePath(path: string | undefined): string {
  if (path === undefined || path === '' || path === '/') return '';
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/** The path below `basePath`, or undefined when the path is outside it. */
export function stripBasePath(pathname: string, basePath: string): string | undefined {
  if (basePath === '') return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return undefined;
}

async function readBody(request: NodeRequest, limit: number): Promise<unknown> {
  // Express and other frameworks may have parsed the body already (application/json).
  if (request.readableEnded || !request.readable) {
    return request.body;
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw ScimError.payloadTooLarge(`The request body is larger than ${limit} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw ScimError.payloadTooLarge(`The request body is larger than ${limit} bytes.`);
    chunks.push(buffer);
  }
  if (size === 0) return request.body;
  return Buffer.concat(chunks).toString('utf8');
}

function baseUrlOf(request: NodeRequest, basePath: string, trustProxy: boolean): string {
  const first = (value: string | string[] | undefined) => {
    const text = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    return text === '' ? undefined : text;
  };
  const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
  const protocol =
    (trustProxy ? first(request.headers['x-forwarded-proto']) : undefined) ?? (encrypted ? 'https' : 'http');
  const host =
    (trustProxy ? first(request.headers['x-forwarded-host']) : undefined) ??
    first(request.headers.host) ??
    'localhost';
  return `${protocol}://${host}${request.baseUrl ?? ''}${basePath}`;
}

function errorResult(error: unknown): ScimHttpResponse {
  const scim = isScimError(error) ? error : ScimError.internal();
  return {
    status: scim.status,
    headers: { 'Content-Type': 'application/scim+json; charset=utf-8', ...scim.headers },
    body: scim.toJSON(),
  };
}

function send(response: ServerResponse, result: ScimHttpResponse): void {
  if (response.headersSent) return;
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  if (result.body === undefined) {
    response.end();
    return;
  }
  const text = JSON.stringify(result.body);
  response.setHeader('Content-Length', Buffer.byteLength(text));
  response.end(text);
}
