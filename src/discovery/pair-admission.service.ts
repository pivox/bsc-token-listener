import type { Address } from 'viem';
import type { PairInfo, TokenMetadata, TokenSession } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import { restoreReappearedPairSession } from './reappeared-pair.js';

export interface PairAdmissionDependencies {
  sessions: {
    findByPair(pair: Address): Promise<TokenSession | null>;
    save(session: TokenSession): Promise<void>;
  };
  discovered: {
    upsert(input: {
      pair: PairInfo;
      metadata?: TokenMetadata;
      source: 'PAIR_CREATED';
    }): Promise<void>;
  };
  ignored: {
    isIgnored(token: Address): Promise<boolean>;
  };
  metadata: {
    read(token: Address): Promise<TokenMetadata>;
  };
  isMonitored(pair: Address): boolean;
  scheduleMonitor(): void;
  targetBuysAfterEntry: number;
  now(): number;
}

export class PairAdmissionService {
  constructor(private readonly dependencies: PairAdmissionDependencies) {}

  async admit(pair: PairInfo): Promise<void> {
    if (this.dependencies.isMonitored(pair.pair)) return;

    const existing = await this.dependencies.sessions.findByPair(pair.pair);
    if (existing) {
      const restored = restoreReappearedPairSession(
        existing,
        pair,
        this.dependencies.now(),
      );
      if (restored) {
        await this.dependencies.discovered.upsert({
          pair,
          metadata: restored.metadata,
          source: 'PAIR_CREATED',
        });
        await this.dependencies.sessions.save(restored);
      }
      this.dependencies.scheduleMonitor();
      return;
    }

    if (await this.dependencies.ignored.isIgnored(pair.token)) {
      logger.info(
        { pair: pair.pair, token: pair.token },
        'Paire ignorée: le token figure dans la liste d’ignorance.',
      );
      return;
    }

    await this.dependencies.discovered.upsert({
      pair,
      source: 'PAIR_CREATED',
    });

    let metadata: TokenMetadata;
    try {
      metadata = await this.dependencies.metadata.read(pair.token);
    } catch (error) {
      logger.warn(
        {
          pair: pair.pair,
          token: pair.token,
          reason: errorMessage(error),
        },
        'Nouvelle paire ignorée: contrat non compatible BEP-20 minimal.',
      );
      return;
    }

    await this.dependencies.discovered.upsert({
      pair,
      metadata,
      source: 'PAIR_CREATED',
    });

    const now = this.dependencies.now();
    const session: TokenSession = {
      pair,
      metadata,
      status: 'WAITING_FIRST_BUY',
      entryObservationBuys: [],
      subsequentBuyCount: 0,
      targetBuysAfterEntry: this.dependencies.targetBuysAfterEntry,
      countedBuyTransactionHashes: [],
      sellAttempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.dependencies.sessions.save(session);
    logger.info(
      {
        pair: pair.pair,
        token: pair.token,
        name: metadata.name,
        symbol: metadata.symbol,
        blockNumber: pair.createdBlock.toString(),
        transactionHash: pair.createdTransactionHash,
      },
      'Nouvelle paire Token/WBNB enregistrée.',
    );
    this.dependencies.scheduleMonitor();
  }
}
