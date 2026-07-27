import { loadConfig } from '../src/config/env.js';
import { PostgresStore } from '../src/storage/postgres-store.js';

const config = loadConfig();
const store = new PostgresStore(config.databaseUrl, false);
try {
  await store.migrate();
  console.log('Migration PostgreSQL appliquée.');
} finally {
  await store.close();
}
