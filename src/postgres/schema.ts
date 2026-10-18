/** The parts of a `pg` result scimkit reads. */
export interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}

export interface PgPoolClient extends PgQueryable {
  release(error?: Error | boolean): void;
}

/** A connection pool with the interface of `pg.Pool` (node-postgres 8). */
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

export interface PostgresTableOptions {
  /** Database schema of the tables. Default "public". */
  schema?: string;
  /** Prefix of the table names. Default "scim_". */
  tablePrefix?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,40}$/;

/** Quoted, schema-qualified names of scimkit's tables. */
export interface TableNames {
  readonly schema: string;
  readonly prefix: string;
  readonly resources: string;
  readonly members: string;
  readonly tokens: string;
  readonly migrations: string;
  /** Builds a quoted index name. */
  index(name: string): string;
}

export function tableNames(options: PostgresTableOptions = {}): TableNames {
  const schema = options.schema ?? 'public';
  const prefix = options.tablePrefix ?? 'scim_';
  if (!IDENTIFIER.test(schema))
    throw new TypeError(`Invalid schema name "${schema}": use lowercase letters, digits and _.`);
  if (prefix !== '' && !IDENTIFIER.test(prefix)) {
    throw new TypeError(`Invalid table prefix "${prefix}": use lowercase letters, digits and _.`);
  }
  const qualify = (name: string) => `"${schema}"."${prefix}${name}"`;
  return {
    schema,
    prefix,
    resources: qualify('resources'),
    members: qualify('group_members'),
    tokens: qualify('tokens'),
    migrations: qualify('migrations'),
    index: (name) => `"${prefix}${name}"`,
  };
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: (tables: TableNames) => string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'resources, group members and tokens',
    statements: (t) => [
      `CREATE TABLE IF NOT EXISTS ${t.resources} (
  tenant_id     text        NOT NULL,
  id            text        NOT NULL,
  resource_type text        NOT NULL,
  seq           bigserial   NOT NULL,
  external_id   text,
  user_name     text,
  display_name  text,
  data          jsonb       NOT NULL,
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t.index('resources_user_name')}
  ON ${t.resources} (tenant_id, resource_type, lower(user_name)) WHERE user_name IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ${t.index('resources_type_seq')} ON ${t.resources} (tenant_id, resource_type, seq)`,
      `CREATE INDEX IF NOT EXISTS ${t.index('resources_external_id')}
  ON ${t.resources} (tenant_id, resource_type, external_id) WHERE external_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ${t.index('resources_display_name')}
  ON ${t.resources} (tenant_id, resource_type, lower(display_name))`,
      `CREATE INDEX IF NOT EXISTS ${t.index('resources_data')} ON ${t.resources} USING gin (data jsonb_path_ops)`,
      `CREATE TABLE IF NOT EXISTS ${t.members} (
  tenant_id text      NOT NULL,
  group_id  text      NOT NULL,
  member_id text      NOT NULL,
  seq       bigserial NOT NULL,
  PRIMARY KEY (tenant_id, group_id, member_id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES ${t.resources} (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, member_id) REFERENCES ${t.resources} (tenant_id, id) ON DELETE CASCADE
)`,
      `CREATE INDEX IF NOT EXISTS ${t.index('group_members_member')} ON ${t.members} (tenant_id, member_id)`,
      `CREATE TABLE IF NOT EXISTS ${t.tokens} (
  id           text        PRIMARY KEY,
  tenant_id    text        NOT NULL,
  label        text,
  secret_hash  text        NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz
)`,
      `CREATE INDEX IF NOT EXISTS ${t.index('tokens_tenant')} ON ${t.tokens} (tenant_id)`,
    ],
  },
];

/** The SQL scimkit's migrations run, for use with your own migration tool. */
export function migrationSql(options: PostgresTableOptions = {}): string {
  const tables = tableNames(options);
  const prelude = tables.schema === 'public' ? [] : [`CREATE SCHEMA IF NOT EXISTS "${tables.schema}"`];
  const statements = [...prelude, ...MIGRATIONS.flatMap((migration) => migration.statements(tables))];
  return `${statements.join(';\n\n')};\n`;
}

/**
 * Creates or upgrades scimkit's tables. Safe to run on every start and from
 * several processes at once: an advisory lock serialises concurrent runs.
 * Returns the versions it applied.
 */
export async function migrate(pool: PgPool, options: PostgresTableOptions = {}): Promise<number[]> {
  const tables = tableNames(options);
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `scimkit:migrate:${tables.schema}.${tables.prefix}`,
    ]);
    if (tables.schema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS "${tables.schema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${tables.migrations} (
  version    integer     PRIMARY KEY,
  name       text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);
    const { rows } = await client.query(`SELECT version FROM ${tables.migrations}`);
    const done = new Set((rows as { version: number }[]).map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue;
      for (const statement of migration.statements(tables)) await client.query(statement);
      await client.query(`INSERT INTO ${tables.migrations} (version, name) VALUES ($1, $2)`, [
        migration.version,
        migration.name,
      ]);
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `work` in a transaction on one pooled connection. */
export async function transaction<T>(pool: PgPool, work: (client: PgQueryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The SQLSTATE of a node-postgres error, if it is one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
