import type { Address } from 'viem';
import type {
  ClassifiedSwap,
  DiscoveredTokenRecord,
  SessionSnapshot,
  TradeRecord,
} from '../types/domain.js';
import type { BotStore } from './store.js';

const terminalStatuses = new Set(['CLOSED', 'REJECTED', 'EXPIRED', 'ERROR']);

export class MemoryStore implements BotStore {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly swapIds = new Set<string>();
  private readonly trades = new Map<string, TradeRecord>();
  private readonly discoveredTokens = new Map<string, DiscoveredTokenRecord>();

  public async initialize(): Promise<void> {}

  public async saveSession(session: SessionSnapshot): Promise<void> {
    this.sessions.set(session.pair.pair.toLowerCase(), structuredClone(session));
  }

  public async getSession(pair: Address): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(pair.toLowerCase());
    return session === undefined ? undefined : structuredClone(session);
  }

  public async listOpenSessions(): Promise<SessionSnapshot[]> {
    return [...this.sessions.values()]
      .filter((session) => !terminalStatuses.has(session.status))
      .map((session) => structuredClone(session));
  }

  public async saveSwapEvent(event: ClassifiedSwap): Promise<boolean> {
    if (this.swapIds.has(event.id)) {
      return false;
    }
    this.swapIds.add(event.id);
    return true;
  }

  public async saveTrade(trade: TradeRecord): Promise<void> {
    this.trades.set(trade.id, structuredClone(trade));
  }

  public async saveDiscoveredToken(token: DiscoveredTokenRecord): Promise<void> {
    this.discoveredTokens.set(token.address.toLowerCase(), structuredClone(token));
  }

  public async close(): Promise<void> {}
}
