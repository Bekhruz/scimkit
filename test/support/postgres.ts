import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const DATABASE_URL = process.env['SCIMKIT_TEST_DATABASE_URL'];

if (DATABASE_URL === undefined && process.env['SCIMKIT_REQUIRE_POSTGRES'] === '1') {
  throw new Error('SCIMKIT_REQUIRE_POSTGRES is set but SCIMKIT_TEST_DATABASE_URL is not.');
}

export const hasPostgres = DATABASE_URL !== undefined;

/** A pool and a fresh schema for one test file; `drop()` removes both. */
export async function isolatedSchema(): Promise<{ pool: pg.Pool; schema: string; drop(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  const schema = `scimkit_test_${randomBytes(4).toString('hex')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    schema,
    async drop() {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}
