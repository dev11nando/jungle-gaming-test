import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM, type Options } from '@mikro-orm/postgresql';
import { Migration20261113000000_initial_schema } from './migrations/Migration20261113000000_initial_schema';
import { ALL_SCHEMAS } from './records';

export const MIGRATIONS = [
  { name: 'Migration20261113000000_initial_schema', class: Migration20261113000000_initial_schema },
];

export function createOrmOptions(databaseUrl: string, overrides: Partial<Options> = {}): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    forceUtcTimezone: true,
    allowGlobalContext: false,
    debug: false,
    pool: { min: 0, max: 10 },
    ...overrides,
  });
}

export function initOrm(databaseUrl: string, overrides: Partial<Options> = {}): Promise<MikroORM> {
  return MikroORM.init(createOrmOptions(databaseUrl, overrides));
}
