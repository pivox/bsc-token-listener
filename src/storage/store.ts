import type {
  ClassifiedSwap,
  DiscoveredTokenRecord,
  SessionSnapshot,
  TradeRecord,
} from '../types/domain.js';
import type { Address } from 'viem';

export interface BotStore {
  initialize(): Promise<void>;
  saveSession(session: SessionSnapshot): Promise<void>;
  getSession(pair: Address): Promise<SessionSnapshot | undefined>;
  listOpenSessions(): Promise<SessionSnapshot[]>;
  saveSwapEvent(event: ClassifiedSwap): Promise<boolean>;
  saveTrade(trade: TradeRecord): Promise<void>;
  saveDiscoveredToken(token: DiscoveredTokenRecord): Promise<void>;
  close(): Promise<void>;
}
