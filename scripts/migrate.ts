import 'dotenv/config';
import { closeDatabase, migrate } from '../src/storage/database.js';

await migrate();
await closeDatabase();
