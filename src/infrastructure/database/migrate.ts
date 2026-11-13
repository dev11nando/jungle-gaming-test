import { loadAppConfig } from '../../config/app-config';
import { initOrm } from './mikro-orm.config';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const databaseUrl = process.env.DATABASE_URL ?? loadAppConfig().databaseUrl;
  const orm = await initOrm(databaseUrl);
  const migrator = orm.getMigrator();
  try {
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(JSON.stringify({ applied: applied.map((m) => m.name) }));
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(JSON.stringify({ reverted: reverted.map((m) => m.name) }));
        break;
      }
      case 'down:all': {
        const reverted = await migrator.down({ to: 0 });
        console.log(JSON.stringify({ reverted: reverted.map((m) => m.name) }));
        break;
      }
      case 'status': {
        const executed = await migrator.getExecutedMigrations();
        const pending = await migrator.getPendingMigrations();
        console.log(JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }));
        break;
      }
      default:
        throw new Error(`unknown command ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
