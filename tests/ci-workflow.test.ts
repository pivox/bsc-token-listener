import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

test('la CI provisionne PostgreSQL 16 avec une URL de test locale', () => {
  assert.match(workflow, /services:\n\s+postgres:/u);
  assert.match(workflow, /image: postgres:16-alpine/u);
  assert.match(workflow, /POSTGRES_DB: bscbot/u);
  assert.match(workflow, /POSTGRES_USER: bscbot/u);
  assert.match(workflow, /POSTGRES_PASSWORD: bscbot/u);
  assert.match(workflow, /5432:5432/u);
  assert.match(workflow, /pg_isready -U bscbot -d bscbot/u);
  assert.match(
    workflow,
    /TEST_DATABASE_URL: postgresql:\/\/bscbot:bscbot@127\.0\.0\.1:5432\/bscbot/u,
  );
});
