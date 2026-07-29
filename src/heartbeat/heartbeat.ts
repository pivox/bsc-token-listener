import { errorMessage } from '../utils/error.js';
import type { CheckpointRepository, SessionRepository } from '../storage/repositories.js';
import type { ExecutionMode } from '../types/domain.js';
import type { RecoveryCoordinatorStatus } from '../recovery/recovery-coordinator.js';
import type { MonitorSchedulerStatus } from '../monitoring/monitor-scheduler.js';
import type {
  CanonicalChainState,
  ChainReorgStatus,
} from '../chain/canonical-chain.types.js';

export type RpcStatus = 'up' | 'down';

export interface RpcHealth {
  status: RpcStatus;
  blockNumber: string | null;
  error: string | null;
}

export interface ChainReorgHealth {
  detectedAt: string;
  depth: number | null;
  commonAncestorNumber: string | null;
  commonAncestorHash: string | null;
  status: ChainReorgStatus;
  orphanedEvents: number;
  replayedEvents: number;
}

export interface ChainHealth {
  confirmations: number;
  confirmedHead: string | null;
  canonicalBlockNumber: string | null;
  canonicalBlockHash: string | null;
  state: CanonicalChainState;
  stale: boolean;
  lastReorg: ChainReorgHealth | null;
}

export interface HeartbeatSnapshot {
  generatedAt: string;
  executionMode: ExecutionMode;
  latestBlock: string | null;
  pairCreatedCheckpoint: string | null;
  activeSwapMonitors: number;
  activeSessions: number;
  monitoring: MonitorSchedulerStatus;
  http: RpcHealth;
  webSocket: RpcHealth;
  recovery: {
    running: boolean;
    lastCompletedAt: string | null;
    lastErrorType: string | null;
    lastProcessedSessions: number;
    pendingSessions: number;
    manualReviewSessions: number;
  };
  chain: ChainHealth;
}

export interface HeartbeatDependencies {
  getHttpLatestBlock: () => Promise<bigint>;
  getWsLatestBlock: () => Promise<bigint>;
}

interface RecoveryStatusProvider {
  readonly currentStatus: RecoveryCoordinatorStatus;
}

export interface ChainHealthProvider {
  readonly confirmations: number;
  getHealth(latestBlock: bigint | null): Promise<ChainHealth>;
}

export class HeartbeatService {
  private snapshot: HeartbeatSnapshot | null = null;
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly checkpoints: CheckpointRepository,
    private readonly sessions: SessionRepository,
    private readonly dependencies: HeartbeatDependencies,
    private readonly executionMode: ExecutionMode,
    private readonly recovery?: RecoveryStatusProvider,
    private readonly chainHealth?: ChainHealthProvider,
  ) {}

  get currentSnapshot(): HeartbeatSnapshot | null {
    return this.snapshot;
  }

  refresh(
    activeSwapMonitors: number,
    monitoring?: MonitorSchedulerStatus,
  ): Promise<HeartbeatSnapshot> {
    const refresh = this.refreshTail.then(() =>
      this.refreshOnce(activeSwapMonitors, monitoring));
    this.refreshTail = refresh.then(
      () => undefined,
      () => undefined,
    );
    return refresh;
  }

  private async refreshOnce(
    activeSwapMonitors: number,
    monitoring?: MonitorSchedulerStatus,
  ): Promise<HeartbeatSnapshot> {
    const [
      pairCreatedCheckpoint,
      activeSessions,
      http,
      webSocket,
    ] = await Promise.all([
      this.checkpoints.get('pair-created'),
      this.sessions.countActive(),
      this.fetchRpcHealth(this.dependencies.getHttpLatestBlock),
      this.fetchRpcHealth(this.dependencies.getWsLatestBlock),
    ]);

    const latestBlock = http.blockNumber ?? this.snapshot?.latestBlock ?? null;
    const chain = await this.fetchChainHealth(
      http.blockNumber === null ? null : BigInt(http.blockNumber),
    );

    this.snapshot = {
      generatedAt: new Date().toISOString(),
      executionMode: this.executionMode,
      latestBlock,
      pairCreatedCheckpoint: pairCreatedCheckpoint?.blockNumber.toString() ?? null,
      activeSwapMonitors,
      activeSessions,
      monitoring: monitoring ?? {
        capacity: activeSwapMonitors,
        activeMonitors: activeSwapMonitors,
        waitingSessions: 0,
        abandonedSessions: 0,
        oldestWaitingAgeMs: null,
      },
      http,
      webSocket,
      recovery: this.recoverySnapshot(),
      chain,
    };

    return this.snapshot;
  }

  private async fetchChainHealth(latestBlock: bigint | null): Promise<ChainHealth> {
    try {
      if (!this.chainHealth || latestBlock === null) {
        throw new Error('Tête HTTP non validée pour la santé canonique.');
      }
      return await this.chainHealth.getHealth(latestBlock);
    } catch {
      const previous = this.snapshot?.chain;
      if (previous) {
        return {
          ...previous,
          stale: true,
          state: previous.state === 'HEALTHY' ? 'RECONCILING' : previous.state,
        };
      }
      return {
        confirmations: this.chainHealth?.confirmations ?? 0,
        confirmedHead: null,
        canonicalBlockNumber: null,
        canonicalBlockHash: null,
        state: 'RECONCILING',
        stale: true,
        lastReorg: null,
      };
    }
  }

  private recoverySnapshot(): HeartbeatSnapshot['recovery'] {
    const status = this.recovery?.currentStatus;
    return {
      running: status?.running ?? false,
      lastCompletedAt: status?.lastCompletedAtMs
        ? new Date(status.lastCompletedAtMs).toISOString()
        : null,
      lastErrorType: status?.lastErrorType ?? null,
      lastProcessedSessions: status?.lastProcessedSessions ?? 0,
      pendingSessions: status?.pendingSessions ?? 0,
      manualReviewSessions: status?.manualReviewSessions ?? 0,
    };
  }

  private async fetchRpcHealth(
    getter: () => Promise<bigint>,
  ): Promise<RpcHealth> {
    try {
      const blockNumber = await getter();
      return {
        status: 'up',
        blockNumber: blockNumber.toString(),
        error: null,
      };
    } catch (error) {
      return {
        status: 'down',
        blockNumber: null,
        error: errorMessage(error),
      };
    }
  }
}
