import { getAddress, isAddress, type Address } from 'viem';
import { IgnoredAssetRepository } from '../storage/ignored-asset.repository.js';
import { pool } from '../storage/database.js';
import { SessionEngine } from '../strategy/session-engine.js';
import type { TokenSession } from '../types/domain.js';
import { parseJson } from '../utils/json.js';
import { canIgnoreAsset, canManuallySell } from './action-policy.js';

export interface DashboardActionResult {
  tokenAddress: Address;
  pairAddress: Address | null;
  status: string;
  transactionHash: string | null;
}

export class DashboardActionService {
  constructor(
    private readonly ignoredAssets: IgnoredAssetRepository,
    private readonly engine: SessionEngine,
    private readonly findActiveSession: (token: Address) => TokenSession | null,
    private readonly stopMonitor: (pair: Address) => void,
  ) {}

  async listIgnored(): Promise<Address[]> {
    return this.ignoredAssets.listTokenAddresses();
  }

  async ignore(tokenInput: string): Promise<DashboardActionResult> {
    const token = this.parseAddress(tokenInput, 'tokenAddress');
    const session = await this.findSession(token);
    if (!canIgnoreAsset(session)) {
      throw new Error('Cet actif ne peut pas être ignoré pendant ou après une position ouverte.');
    }

    const pair = session?.pair.pair ?? await this.findDiscoveredPair(token);
    await this.ignoredAssets.ignore({
      token,
      pair,
      reason: 'Ignoré manuellement depuis le dashboard local.',
    });

    if (session) {
      await this.engine.ignoreManually(session);
      this.stopMonitor(session.pair.pair);
    }

    return {
      tokenAddress: token,
      pairAddress: pair,
      status: 'IGNORED',
      transactionHash: null,
    };
  }

  async sell(tokenInput: string): Promise<DashboardActionResult> {
    const token = this.parseAddress(tokenInput, 'tokenAddress');
    const session = await this.findSession(token);
    if (!canManuallySell(session)) {
      throw new Error('Aucune position ouverte vendable pour cet actif.');
    }

    const updated = await this.engine.sellManually(session!);
    if (updated.status === 'CLOSED') this.stopMonitor(updated.pair.pair);
    return {
      tokenAddress: updated.pair.token,
      pairAddress: updated.pair.pair,
      status: updated.status,
      transactionHash: updated.exit?.transactionHash ?? null,
    };
  }

  private parseAddress(value: string, field: string): Address {
    if (!isAddress(value, { strict: false })) {
      throw new Error(`${field} doit être une adresse EVM valide.`);
    }
    return getAddress(value.toLowerCase());
  }

  private async findSession(token: Address): Promise<TokenSession | null> {
    const active = this.findActiveSession(token);
    if (active) return active;

    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload
       FROM token_sessions
       WHERE token_address = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [token.toLowerCase()],
    );
    const row = result.rows[0];
    return row ? parseJson<TokenSession>(row.payload) : null;
  }

  private async findDiscoveredPair(token: Address): Promise<Address | null> {
    const result = await pool.query<{ pair_address: string | null }>(
      'SELECT pair_address FROM discovered_tokens WHERE token_address = $1 LIMIT 1',
      [token.toLowerCase()],
    );
    const value = result.rows[0]?.pair_address;
    return value && isAddress(value, { strict: false })
      ? getAddress(value.toLowerCase())
      : null;
  }
}
