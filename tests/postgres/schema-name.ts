import { randomUUID } from 'node:crypto';

export function schemaName(prefix: string, label: string): string {
  const normalizedLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '') || 'scenario';
  return `${prefix}_${normalizedLabel}_${randomUUID().replaceAll('-', '')}`;
}
