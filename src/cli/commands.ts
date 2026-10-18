import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { ScimTokens } from 'scimkit';
import { migrate, migrationSql, type PgPool, PostgresTokenStore } from 'scimkit/postgres';
import { formatReport, PROFILE_NAMES, type ProfileName, verifyScimEndpoint } from 'scimkit/verify';

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly color: boolean;
  /** Opens a pg.Pool for a connection string; injectable for tests. */
  readonly openPool: (connectionString: string) => Promise<PgPool & { end(): Promise<void> }>;
  readonly fetch?: typeof fetch;
}

export class UsageError extends Error {}

export const HELP = `scimkit: SCIM 2.0 provisioning tools

Usage:
  scimkit verify <base-url> [--token <token>] [--profile rfc,okta,entra] [--json] [--keep]
  scimkit migrate [--database-url <url>] [--schema <name>] [--table-prefix <prefix>] [--print]
  scimkit token create --tenant <id> [--label <text>] [--expires-in-days <n>] [database options]
  scimkit token list --tenant <id> [database options]
  scimkit token revoke <token-id> [database options]

verify     Replays the requests Okta and Microsoft Entra ID send (and the core
           RFC protocol) against a SCIM endpoint, then deletes what it created.
           The token can also come from SCIM_TOKEN.
migrate    Creates or upgrades scimkit's PostgreSQL tables.
token      Issues, lists and revokes per-tenant bearer tokens.

Database options: --database-url (or DATABASE_URL), --schema (default public),
--table-prefix (default scim_). Database commands need the "pg" package.

Exit codes: 0 success, 1 failed checks or errors, 2 usage errors.
`;

const DATABASE_OPTIONS: ParseArgsOptionsConfig = {
  'database-url': { type: 'string' },
  schema: { type: 'string' },
  'table-prefix': { type: 'string' },
};

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

function parse(args: string[], options: ParseArgsOptionsConfig): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function tableOptions(values: Record<string, unknown>): { schema?: string; tablePrefix?: string } {
  return {
    ...(typeof values['schema'] === 'string' ? { schema: values['schema'] } : {}),
    ...(typeof values['table-prefix'] === 'string' ? { tablePrefix: values['table-prefix'] } : {}),
  };
}

async function withPool<T>(
  values: Record<string, unknown>,
  io: Io,
  work: (pool: PgPool) => Promise<T>,
): Promise<T> {
  const url = (values['database-url'] as string | undefined) ?? io.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new UsageError('Pass --database-url or set DATABASE_URL.');
  const pool = await io.openPool(url);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

export async function verifyCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    token: { type: 'string' },
    profile: { type: 'string' },
    json: { type: 'boolean' },
    keep: { type: 'boolean' },
    timeout: { type: 'string' },
    header: { type: 'string', multiple: true },
  });
  if (values['help'] === true) {
    io.stdout(HELP);
    return 0;
  }
  const [baseUrl] = positionals;
  if (baseUrl === undefined || positionals.length > 1)
    throw new UsageError('verify takes one base URL, such as https://app.example.com/scim/v2.');
  if (!/^https?:\/\//.test(baseUrl)) throw new UsageError(`"${baseUrl}" is not an http(s) URL.`);
  const profiles = ((values['profile'] as string | undefined) ?? PROFILE_NAMES.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const profile of profiles) {
    if (!PROFILE_NAMES.includes(profile as ProfileName))
      throw new UsageError(`Unknown profile "${profile}"; use rfc, okta or entra.`);
  }
  const timeout = values['timeout'] === undefined ? undefined : Number(values['timeout']);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
    throw new UsageError('--timeout is a number of milliseconds.');
  const headers: Record<string, string> = {};
  for (const entry of (values['header'] as string[] | undefined) ?? []) {
    const colon = entry.indexOf(':');
    if (colon < 1) throw new UsageError(`--header "${entry}" must look like "Name: value".`);
    headers[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
  }
  const token = (values['token'] as string | undefined) ?? io.env['SCIM_TOKEN'];
  const json = values['json'] === true;
  const report = await verifyScimEndpoint({
    baseUrl,
    profiles: profiles as ProfileName[],
    keep: values['keep'] === true,
    ...(token === undefined ? {} : { token }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, { color: io.color }));
  return report.failed > 0 ? 1 : 0;
}

export async function migrateCommand(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { ...DATABASE_OPTIONS, print: { type: 'boolean' } });
  if (values['help'] === true) {
    io.stdout(HELP);
    return 0;
  }
  if (values['print'] === true) {
    io.stdout(migrationSql(tableOptions(values)));
    return 0;
  }
  const applied = await withPool(values, io, (pool) => migrate(pool, tableOptions(values)));
  io.stdout(
    applied.length === 0 ? 'The database is up to date.\n' : `Applied migration ${applied.join(', ')}.\n`,
  );
  return 0;
}

export async function tokenCommand(args: string[], io: Io): Promise<number> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, {
    ...DATABASE_OPTIONS,
    tenant: { type: 'string' },
    label: { type: 'string' },
    'expires-in-days': { type: 'string' },
    json: { type: 'boolean' },
  });
  if (values['help'] === true || action === undefined) {
    io.stdout(HELP);
    return action === undefined ? 2 : 0;
  }
  const tenant = values['tenant'] as string | undefined;
  const json = values['json'] === true;
  return withPool(values, io, async (pool) => {
    const tokens = new ScimTokens(new PostgresTokenStore({ pool, ...tableOptions(values) }));
    switch (action) {
      case 'create': {
        if (tenant === undefined) throw new UsageError('token create needs --tenant.');
        const days = values['expires-in-days'] === undefined ? undefined : Number(values['expires-in-days']);
        if (days !== undefined && !(Number.isFinite(days) && days > 0))
          throw new UsageError('--expires-in-days is a positive number.');
        const issued = await tokens.issue(tenant, {
          ...(typeof values['label'] === 'string' ? { label: values['label'] } : {}),
          ...(days === undefined ? {} : { expiresAt: new Date(Date.now() + days * 86_400_000) }),
        });
        if (json) {
          io.stdout(
            `${JSON.stringify({ token: issued.token, id: issued.record.id, tenantId: tenant, expiresAt: issued.record.expiresAt }, null, 2)}\n`,
          );
        } else {
          io.stdout(
            [
              `Token ${issued.record.id} for tenant ${tenant}${issued.record.expiresAt === undefined ? '' : `, expires ${issued.record.expiresAt.toISOString()}`}:`,
              '',
              `  ${issued.token}`,
              '',
              'Store it in the identity provider now: it cannot be shown again.',
              '',
            ].join('\n'),
          );
        }
        return 0;
      }
      case 'list': {
        if (tenant === undefined) throw new UsageError('token list needs --tenant.');
        const records = await tokens.list(tenant);
        if (json) {
          io.stdout(
            `${JSON.stringify(
              records.map(({ secretHash, ...record }) => record),
              null,
              2,
            )}\n`,
          );
          return 0;
        }
        if (records.length === 0) io.stdout(`No tokens for tenant ${tenant}.\n`);
        for (const record of records) {
          const state =
            record.revokedAt !== undefined
              ? 'revoked'
              : record.expiresAt !== undefined && record.expiresAt <= new Date()
                ? 'expired'
                : 'active';
          io.stdout(
            `${record.id}  ${state.padEnd(7)}  created ${record.createdAt.toISOString()}  last used ${record.lastUsedAt?.toISOString() ?? 'never'}${record.label === undefined ? '' : `  ${record.label}`}\n`,
          );
        }
        return 0;
      }
      case 'revoke': {
        const [id] = positionals;
        if (id === undefined) throw new UsageError('token revoke needs a token id.');
        const revoked = await tokens.revoke(id);
        io.stdout(revoked ? `Revoked token ${id}.\n` : `No active token ${id}.\n`);
        return revoked ? 0 : 1;
      }
      default:
        throw new UsageError(`Unknown token command "${action}"; use create, list or revoke.`);
    }
  });
}

/** Runs the CLI and returns its exit code. */
export async function runCli(argv: string[], io: Io, version: string): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'verify':
        return await verifyCommand(args, io);
      case 'migrate':
        return await migrateCommand(args, io);
      case 'token':
        return await tokenCommand(args, io);
      case '--version':
      case '-v':
        io.stdout(`${version}\n`);
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`scimkit: ${error.message}\nRun "scimkit help" for usage.\n`);
      return 2;
    }
    io.stderr(`scimkit: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
