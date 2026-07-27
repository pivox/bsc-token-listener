import type { AppConfig } from '../config/env.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import type { BotStore } from './store.js';

export function createStore(config: AppConfig): BotStore {
  if (config.storageDriver === 'postgres') {
    return new PostgresStore(config.databaseUrl, config.postgresAutoMigrate);
  }
  return new MemoryStore();
}
