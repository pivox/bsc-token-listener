import { getAddress, type Address } from 'viem';
import { pool } from './database.js';

export interface IgnoredAsset {
  token: Address;
  pair: Address | null;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

export class IgnoredAssetRepository {
  async isIgnored(token: Address): Promise<boolean> {
    const result = await pool.query<{ ignored: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM ignored_assets WHERE token_address = $1) AS ignored',
      [token.toLowerCase()],
    );
    return Boolean(result.rows[0]?.ignored);
  }

  async ignore(input: {
    token: Address;
    pair?: Address | null;
    reason: string;
  }): Promise<IgnoredAsset> {
    const result = await pool.query<{
      token_address: string;
      pair_address: string | null;
      reason: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO ignored_assets(token_address, pair_address, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_address) DO UPDATE SET
         pair_address = COALESCE(EXCLUDED.pair_address, ignored_assets.pair_address),
         reason = EXCLUDED.reason,
         updated_at = NOW()
       RETURNING token_address, pair_address, reason, created_at, updated_at`,
      [
        input.token.toLowerCase(),
        input.pair?.toLowerCase() ?? null,
        input.reason.slice(0, 500),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Impossible de persister l’actif ignoré.');
    return {
      token: getAddress(row.token_address),
      pair: row.pair_address ? getAddress(row.pair_address) : null,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listTokenAddresses(): Promise<Address[]> {
    const result = await pool.query<{ token_address: string }>(
      'SELECT token_address FROM ignored_assets ORDER BY updated_at DESC',
    );
    return result.rows.map((row) => getAddress(row.token_address));
  }
}
