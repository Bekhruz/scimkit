import { SCIM_MESSAGES } from './constants.js';

/** The `scimType` values defined by RFC 7644 §3.12. */
export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

/** The JSON body of a SCIM error response. */
export interface ScimErrorBody {
  schemas: [typeof SCIM_MESSAGES.error];
  status: string;
  scimType?: ScimErrorType;
  detail?: string;
}

// A registry-wide symbol, so errors are recognised even when two copies of
// scimkit are loaded (for example the ESM and the CommonJS build).
const SCIM_ERROR = Symbol.for('scimkit.ScimError');

/**
 * An error that maps to a SCIM error response. Throw it from repositories and
 * hooks to answer the client with a specific status and `scimType`; any other
 * error becomes a generic 500 response.
 */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType: ScimErrorType | undefined;
  readonly detail: string;
  /** Extra response headers, such as `WWW-Authenticate` on a 401. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    detail: string,
    scimType?: ScimErrorType,
    options: { cause?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScimError';
    this.status = status;
    this.scimType = scimType;
    this.detail = detail;
    this.headers = options.headers ?? {};
    Object.defineProperty(this, SCIM_ERROR, { value: true });
  }

  toJSON(): ScimErrorBody {
    const body: ScimErrorBody = { schemas: [SCIM_MESSAGES.error], status: String(this.status) };
    if (this.scimType !== undefined) body.scimType = this.scimType;
    body.detail = this.detail;
    return body;
  }

  static invalidFilter(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'invalidFilter');
  }

  static invalidSyntax(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'invalidSyntax');
  }

  static invalidPath(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'invalidPath');
  }

  static invalidValue(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'invalidValue');
  }

  static noTarget(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'noTarget');
  }

  static mutability(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'mutability');
  }

  static invalidVersion(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'invalidVers');
  }

  static sensitive(this: void, detail: string): ScimError {
    return new ScimError(403, detail, 'sensitive');
  }

  static tooMany(this: void, detail: string): ScimError {
    return new ScimError(400, detail, 'tooMany');
  }

  static uniqueness(this: void, detail: string): ScimError {
    return new ScimError(409, detail, 'uniqueness');
  }

  static unauthorized(this: void, detail = 'Authentication is required.'): ScimError {
    return new ScimError(401, detail, undefined, { headers: { 'WWW-Authenticate': 'Bearer realm="SCIM"' } });
  }

  static forbidden(this: void, detail: string): ScimError {
    return new ScimError(403, detail);
  }

  static notFound(this: void, detail: string): ScimError {
    return new ScimError(404, detail);
  }

  static methodNotAllowed(this: void, detail: string, allow: readonly string[]): ScimError {
    return new ScimError(405, detail, undefined, { headers: { Allow: allow.join(', ') } });
  }

  static conflict(this: void, detail: string): ScimError {
    return new ScimError(409, detail);
  }

  static preconditionFailed(
    detail = 'The resource has changed since the version given in If-Match.',
  ): ScimError {
    return new ScimError(412, detail);
  }

  static payloadTooLarge(this: void, detail: string): ScimError {
    return new ScimError(413, detail);
  }

  static unsupportedMediaType(this: void, detail: string): ScimError {
    return new ScimError(415, detail);
  }

  static notImplemented(this: void, detail: string): ScimError {
    return new ScimError(501, detail);
  }

  static internal(this: void, detail = 'An internal error occurred.'): ScimError {
    return new ScimError(500, detail);
  }
}

/** True for a {@link ScimError} from any loaded copy of scimkit. */
export function isScimError(value: unknown): value is ScimError {
  return (
    value instanceof ScimError ||
    (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SCIM_ERROR] === true)
  );
}

const VERSION_CONFLICT = Symbol.for('scimkit.VersionConflictError');

/**
 * Thrown by a repository when a write names an `expectedVersion` that is no
 * longer current. Without an If-Match header from the client the server
 * re-reads the resource and retries; with one, the client receives 412.
 */
export class VersionConflictError extends Error {
  constructor(detail = 'The resource was modified concurrently.') {
    super(detail);
    this.name = 'VersionConflictError';
    Object.defineProperty(this, VERSION_CONFLICT, { value: true });
  }
}

export function isVersionConflict(value: unknown): value is VersionConflictError {
  return (
    value instanceof VersionConflictError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[VERSION_CONFLICT] === true)
  );
}
