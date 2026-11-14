import type { MikroORM } from '@mikro-orm/postgresql';
import { Client, Pool, type PoolClient } from 'pg';
import { initOrm } from '../../src/infra/database/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';

export async function ensureTestDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`create database "${dbName.replace(/"/g, '')}"`);
    }
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04' && (error as { code?: string }).code !== '23505') throw error;
  } finally {
    await client.end();
  }
}

export async function resetSchema(url = TEST_DATABASE_URL): Promise<MikroORM> {
  await ensureTestDatabase(url);
  const orm = await initOrm(url, { pool: { min: 0, max: 20 } });
  const migrator = orm.getMigrator();
  await migrator.down({ to: 0 });
  await migrator.up();
  return orm;
}

export async function migratedOrm(url = TEST_DATABASE_URL): Promise<MikroORM> {
  await ensureTestDatabase(url);
  const orm = await initOrm(url, { pool: { min: 0, max: 20 } });
  await orm.getMigrator().up();
  return orm;
}

export function testPool(url = TEST_DATABASE_URL): Pool {
  return new Pool({ connectionString: url, max: 10 });
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}
