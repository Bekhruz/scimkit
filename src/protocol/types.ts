import type { PatchOperation } from '../patch/apply.js';
import type { JsonObject } from '../resource/json.js';
import type { ScimResource } from '../resource/representation.js';
import type { ScimContext, ScimPrincipal } from '../store/repository.js';

export type HeaderValues = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
export type QueryValues =
  URLSearchParams | string | Readonly<Record<string, string | readonly string[] | undefined>>;

/** An HTTP request in framework-neutral form. Adapters build it; tests can too. */
export interface ScimHttpRequest {
  readonly method: string;
  /** The path below the SCIM root, as received (percent-encoded), for example `/Users/2819c223`. */
  readonly path: string;
  readonly query?: QueryValues;
  readonly headers?: HeaderValues;
  /** Parsed JSON, a JSON string, raw bytes, or undefined. */
  readonly body?: unknown;
  /** Absolute URL of the SCIM root. Used when the server has no `baseUrl` option. */
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

export interface ScimHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON value to serialise, or undefined for no body (204, 304). */
  readonly body?: unknown;
}

/** Verifies the credentials of a request. Return undefined (or throw `ScimError.unauthorized`) to reject it. */
export type Authenticator = (
  request: ScimHttpRequest,
) => ScimPrincipal | undefined | Promise<ScimPrincipal | undefined>;

export interface ScimLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type WriteAction = 'create' | 'replace' | 'patch' | 'delete';

/** Passed to `hooks.beforeWrite` before anything is stored. */
export interface BeforeWriteEvent {
  readonly action: WriteAction;
  readonly context: ScimContext;
  readonly resourceType: string;
  /** Undefined for a create. */
  readonly id?: string;
  /** The validated attributes about to be stored; undefined for a delete. */
  readonly attributes?: JsonObject;
  /** The resource as it is now; undefined for a create. */
  readonly previous?: ScimResource;
  /** The PATCH operations, for a patch. */
  readonly operations?: readonly PatchOperation[];
}

export interface MemberReference {
  readonly value: string;
  readonly type?: string;
}

/** Emitted after a write is stored. */
export type ScimEvent =
  | {
      readonly type: 'resource.created';
      readonly context: ScimContext;
      readonly resourceType: string;
      readonly id: string;
      readonly resource: ScimResource;
    }
  | {
      readonly type: 'resource.updated';
      readonly context: ScimContext;
      readonly resourceType: string;
      readonly id: string;
      readonly operation: 'replace' | 'patch';
      readonly resource: ScimResource;
      readonly previous: ScimResource;
    }
  | {
      readonly type: 'resource.deleted';
      readonly context: ScimContext;
      readonly resourceType: string;
      readonly id: string;
      readonly previous: ScimResource;
    }
  | {
      /** A User's `active` changed to false: revoke its sessions here. */
      readonly type: 'user.deactivated' | 'user.reactivated';
      readonly context: ScimContext;
      readonly resourceType: string;
      readonly id: string;
      readonly resource: ScimResource;
    }
  | {
      readonly type: 'group.members.added' | 'group.members.removed';
      readonly context: ScimContext;
      readonly resourceType: string;
      readonly id: string;
      readonly members: readonly MemberReference[];
    };

export interface ScimHooks {
  /**
   * Runs before every write. Throw a `ScimError` to reject it (for example
   * when a tenant is out of seats), or return new attributes to store instead.
   */
  beforeWrite?: (event: BeforeWriteEvent) => JsonObject | undefined | Promise<JsonObject | undefined>;
  /**
   * Receives events after writes are stored. Errors are logged and do not
   * change the response: the write has already happened.
   */
  onEvent?: (event: ScimEvent) => void | Promise<void>;
  /**
   * Receives passwords sent by the client (a User's `password` attribute).
   * scimkit never stores or returns them. Without this hook passwords are
   * discarded and `changePassword` is advertised as unsupported.
   */
  setPassword?: (
    context: ScimContext,
    details: { readonly resourceType: string; readonly id: string; readonly password: string },
  ) => void | Promise<void>;
}
