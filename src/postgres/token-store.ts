import type { ScimTokenRecord, ScimTokenStore } from '../auth/tokens.js';
import { migrate, type PgPool, type PostgresTableOptions, type TableNames, tableNames } from './schema.js';

export interface PostgresTokenStoreOptions extends PostgresTableOptions {
  pool: PgPool;
}

interface TokenRow {
  id: string;
  tenant_id: string;
  label: string | null;
  secret_hash: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

function toRecord(row: TokenRow): ScimTokenRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.label === null ? {} : { label: row.label }),
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  };
}

/** Keeps SCIM bearer tokens (their hashes) in PostgreSQL, in the table `migrate()` creates. */
export class PostgresTokenStore implements ScimTokenStore {
  private readonly tables: TableNames;
  private readonly pool: PgPool;

  constructor(options: PostgresTokenStoreOptions) {
    this.pool = options.pool;
    this.tables = tableNames(options);
  }

  /** Creates or upgrades the tables (the same migrations as PostgresScimStore). */
  migrate(): Promise<number[]> {
    return migrate(this.pool, { schema: this.tables.schema, tablePrefix: this.tables.prefix });
  }

  async insert(record: ScimTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.tables.tokens} (id, tenant_id, label, secret_hash, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.id,
        record.tenantId,
        record.label ?? null,
        record.secretHash,
        record.createdAt,
        record.expiresAt ?? null,
      ],
    );
  }

  async find(id: string): Promise<ScimTokenRecord | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${this.tables.tokens} WHERE id = $1`, [id]);
    const row = rows[0] as TokenRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async list(tenantId: string): Promise<ScimTokenRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.tables.tokens} WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return (rows as TokenRow[]).map(toRecord);
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.tables.tokens} SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, at],
    );
    return (rowCount ?? 0) > 0;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE ${this.tables.tokens} SET last_used_at = $2 WHERE id = $1`, [id, at]);
  }
}
