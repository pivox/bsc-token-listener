import { confirmedHead } from './confirmed-blocks.js';
import type { CanonicalChainCoordinator } from './canonical-chain.coordinator.js';
import type { CanonicalChainRepository } from './canonical-chain.repository.js';
import type { ChainHealth, ChainHealthProvider } from '../heartbeat/heartbeat.js';
import type {
  CanonicalReorgSummary,
  ChainReorgAudit,
  ChainReorgStatus,
} from './canonical-chain.types.js';

interface ReorgHealthSource {
  identity: string;
  detectedAtMs: number;
  commonAncestorNumber: bigint | null;
  commonAncestorHash: string | null;
  depth: number | null;
  status: ChainReorgStatus;
  orphanedEvents: number;
  replayedEvents: number;
}

function fromMemory(reorg: CanonicalReorgSummary): ReorgHealthSource {
  return {
    identity: `${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`,
    detectedAtMs: reorg.detectedAtMs,
    commonAncestorNumber: reorg.ancestor?.number ?? null,
    commonAncestorHash: reorg.ancestor?.hash ?? null,
    depth: reorg.depth,
    status: reorg.status,
    orphanedEvents: reorg.impact.orphanedEvents,
    replayedEvents: reorg.impact.replayedEvents,
  };
}

function fromPersisted(reorg: ChainReorgAudit): ReorgHealthSource {
  return {
    identity: `${reorg.previousTip.hash.toLowerCase()}:${reorg.replacementTip.hash.toLowerCase()}`,
    detectedAtMs: reorg.detectedAtMs,
    commonAncestorNumber: reorg.commonAncestor?.number ?? null,
    commonAncestorHash: reorg.commonAncestor?.hash ?? null,
    depth: reorg.impact.depth,
    status: reorg.status,
    orphanedEvents: reorg.impact.orphanedEvents,
    replayedEvents: reorg.impact.replayedEvents,
  };
}

function mostRecentReorg(
  memory: CanonicalReorgSummary | null,
  persisted: ChainReorgAudit | null,
): ReorgHealthSource | null {
  const inMemory = memory ? fromMemory(memory) : null;
  const inDatabase = persisted ? fromPersisted(persisted) : null;
  if (!inMemory) return inDatabase;
  if (!inDatabase) return inMemory;
  if (inMemory.identity === inDatabase.identity) {
    if (
      inMemory.status === 'MANUAL_REVIEW'
      || inDatabase.status === 'MANUAL_REVIEW'
    ) return inMemory.status === 'MANUAL_REVIEW' ? inMemory : inDatabase;
    if (
      inMemory.status === 'RECONCILING'
      || inDatabase.status === 'RECONCILING'
    ) return inMemory.status === 'RECONCILING' ? inMemory : inDatabase;
    return inDatabase;
  }
  return inMemory.detectedAtMs >= inDatabase.detectedAtMs
    ? inMemory
    : inDatabase;
}

export class CanonicalChainHealthProvider implements ChainHealthProvider {
  constructor(
    readonly confirmations: number,
    private readonly coordinator: CanonicalChainCoordinator,
    private readonly repository: CanonicalChainRepository,
    private readonly currentRunStartedAtMs = 0,
  ) {}

  async getHealth(latestBlock: bigint | null): Promise<ChainHealth> {
    const [tip, persisted] = await Promise.all([
      this.repository.getCanonicalTip(),
      this.repository.getLastReorg(),
    ]);
    const status = this.coordinator.currentStatus;
    const currentPersisted =
      persisted !== null
      && persisted.detectedAtMs >= this.currentRunStartedAtMs
        ? persisted
        : null;
    const reorg = mostRecentReorg(status.lastReorg, currentPersisted);
    const state = reorg?.status === 'MANUAL_REVIEW'
      ? 'MANUAL_REVIEW'
      : reorg?.status === 'RECONCILING' && status.state === 'HEALTHY'
        ? 'RECONCILING'
        : status.state;
    return {
      confirmations: this.confirmations,
      confirmedHead: latestBlock === null
        ? null
        : confirmedHead(latestBlock, this.confirmations)?.toString() ?? null,
      canonicalBlockNumber: tip?.number.toString() ?? null,
      canonicalBlockHash: tip?.hash ?? null,
      state,
      stale: false,
      lastReorg: reorg
        ? {
          detectedAt: new Date(reorg.detectedAtMs).toISOString(),
          depth: reorg.depth,
          commonAncestorNumber: reorg.commonAncestorNumber?.toString() ?? null,
          commonAncestorHash: reorg.commonAncestorHash,
          status: reorg.status,
          orphanedEvents: reorg.orphanedEvents,
          replayedEvents: reorg.replayedEvents,
        }
        : null,
    };
  }
}
