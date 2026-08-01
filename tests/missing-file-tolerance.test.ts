import assert from 'node:assert/strict';
import test from 'node:test';
import { tolerateMissingFile } from '../src/utils/missing-file-tolerance.js';

test('ignore uniquement une erreur filesystem ENOENT', () => {
  const result = tolerateMissingFile(() => {
    const error = new Error('fichier supprimé') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  });

  assert.equal(result, undefined);
});

test('propage les autres erreurs filesystem', () => {
  const denied = new Error('accès refusé') as NodeJS.ErrnoException;
  denied.code = 'EACCES';

  assert.throws(() => tolerateMissingFile(() => {
    throw denied;
  }), denied);
});
