import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { header } from '../protocol/http.js';
import type { Authenticator, ScimHttpRequest } from '../protocol/types.js';
import type { ScimPrincipal } from '../store/repository.js';

/** A stored SCIM bearer token. The secret itself is never stored, only its SHA-256 hash. */
export interface ScimTokenRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly label?: string;
  readonly secretHash: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  readonly lastUsedAt?: Date;
}

/** Persistence for tokens: `MemoryTokenStore`, `PostgresTokenStore`, or your own. */
export interface ScimTokenStore {
  insert(record: ScimTokenRecord): Promise<void>;
  find(id: string): Promise<ScimTokenRecord | undefined>;
  list(tenantId: string): Promise<ScimTokenRecord[]>;
  /** Returns false when there is no such active token. */
  revoke(id: string, at: Date): Promise<boolean>;
  touch(id: string, at: Date): Promise<void>;
}

export interface IssuedToken {
  /** The token to give to the identity provider. It is shown once and cannot be recovered. */
  readonly token: string;
  readonly record: ScimTokenRecord;
}

export interface ScimTokensOptions {
  /** Token prefix, which makes leaked tokens easy to recognise and scan for. Default "scim". */
  prefix?: string;
  /** How often `lastUsedAt` is updated for a token in use. Default one minute. */
  touchIntervalMs?: number;
  now?: () => Date;
}

const ID_BYTES = 12;
const SECRET_BYTES = 32;

function hash(id: string, secret: string): string {
  return createHash('sha256').update(`${id}.${secret}`).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Issues and verifies per-tenant bearer tokens of the form
 * `scim_<24 hex id>_<43 char secret>`. Give one to each customer's identity
 * provider; revoke it when they rotate or leave.
 */
export class ScimTokens {
  private readonly prefix: string;
  private readonly pattern: RegExp;
  private readonly touchIntervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: ScimTokenStore,
    options: ScimTokensOptions = {},
  ) {
    this.prefix = options.prefix ?? 'scim';
    if (!/^[a-z][a-z0-9]{0,15}$/.test(this.prefix)) {
      throw new TypeError(
        'The token prefix must be 1-16 lowercase letters and digits, starting with a letter.',
      );
    }
    this.pattern = new RegExp(`^${this.prefix}_([0-9a-f]{${ID_BYTES * 2}})_([A-Za-z0-9_-]{43})$`);
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async issue(tenantId: string, options: { label?: string; expiresAt?: Date } = {}): Promise<IssuedToken> {
    if (tenantId === '') throw new TypeError('A token needs a tenant id.');
    const id = randomBytes(ID_BYTES).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const record: ScimTokenRecord = {
      id,
      tenantId,
      ...(options.label === undefined ? {} : { label: options.label }),
      secretHash: hash(id, secret),
      createdAt: this.now(),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    };
    await this.store.insert(record);
    return { token: `${this.prefix}_${id}_${secret}`, record };
  }

  /** The token's record when the token is valid, unexpired and not revoked. */
  async verify(token: string): Promise<ScimTokenRecord | undefined> {
    const match = this.pattern.exec(token);
    if (match === null) return undefined;
    const [, id, secret] = match as unknown as [string, string, string];
    const record = await this.store.find(id);
    if (record === undefined || !sameHash(record.secretHash, hash(id, secret))) return undefined;
    const now = this.now();
    if (record.revokedAt !== undefined && record.revokedAt <= now) return undefined;
    if (record.expiresAt !== undefined && record.expiresAt <= now) return undefined;
    if (
      record.lastUsedAt === undefined ||
      now.getTime() - record.lastUsedAt.getTime() >= this.touchIntervalMs
    ) {
      // Usage tracking is informational; a failure to record it must not reject a valid token.
      await this.store.touch(id, now).catch(() => undefined);
    }
    return record;
  }

  revoke(id: string): Promise<boolean> {
    return this.store.revoke(id, this.now());
  }

  list(tenantId: string): Promise<ScimTokenRecord[]> {
    return this.store.list(tenantId);
  }
}

/** Keeps tokens in memory: for tests and single-process development. */
export class MemoryTokenStore implements ScimTokenStore {
  private readonly records = new Map<string, ScimTokenRecord>();

  insert(record: ScimTokenRecord): Promise<void> {
    if (this.records.has(record.id)) return Promise.reject(new Error(`Token ${record.id} already exists.`));
    this.records.set(record.id, record);
    return Promise.resolve();
  }

  find(id: string): Promise<ScimTokenRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  list(tenantId: string): Promise<ScimTokenRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) => record.tenantId === tenantId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  revoke(id: string, at: Date): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined || record.revokedAt !== undefined) return Promise.resolve(false);
    this.records.set(id, { ...record, revokedAt: at });
    return Promise.resolve(true);
  }

  touch(id: string, at: Date): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) this.records.set(id, { ...record, lastUsedAt: at });
    return Promise.resolve();
  }
}

/** The token of an `Authorization: Bearer <token>` header. */
export function readBearerToken(request: Pick<ScimHttpRequest, 'headers'>): string | undefined {
  const value = header(request.headers, 'authorization');
  const match = value === undefined ? null : /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1];
}

/**
 * Authenticates requests with tokens issued by {@link ScimTokens}, or with
 * your own verification function.
 */
export function bearerTokenAuth(
  verifier: ScimTokens | ((token: string) => ScimPrincipal | undefined | Promise<ScimPrincipal | undefined>),
): Authenticator {
  return async (request) => {
    const token = readBearerToken(request);
    if (token === undefined) return undefined;
    if (verifier instanceof ScimTokens) {
      const record = await verifier.verify(token);
      return record === undefined
        ? undefined
        : {
            tenantId: record.tenantId,
            subject: record.id,
            ...(record.label === undefined ? {} : { tokenLabel: record.label }),
          };
    }
    return verifier(token);
  };
}

/**
 * Authenticates requests against fixed tokens, one per tenant. Suits a
 * single-tenant deployment where the token comes from configuration.
 */
export function staticTokenAuth(
  tokens: { token: string; tenantId: string } | readonly { token: string; tenantId: string }[],
): Authenticator {
  const list = (Array.isArray(tokens) ? tokens : [tokens]) as readonly { token: string; tenantId: string }[];
  if (list.length === 0) throw new TypeError('staticTokenAuth needs at least one token.');
  const digests = list.map(({ token, tenantId }) => {
    if (token.length < 16) throw new TypeError('Static SCIM tokens must be at least 16 characters long.');
    return { digest: createHash('sha256').update(token).digest(), tenantId };
  });
  return (request) => {
    const token = readBearerToken(request);
    if (token === undefined) return undefined;
    const digest = createHash('sha256').update(token).digest();
    let tenantId: string | undefined;
    for (const entry of digests) if (timingSafeEqual(entry.digest, digest)) tenantId ??= entry.tenantId;
    return tenantId === undefined ? undefined : { tenantId, subject: 'static-token' };
  };
}
