import { errorMessage } from '../utils/error.js';
import type { CheckpointRepository, SessionRepository } from '../storage/repositories.js';
import type { ExecutionMode } from '../types/domain.js';
import type { RecoveryCoordinatorStatus } from '../recovery/recovery-coordinator.js';
import type { MonitorSchedulerStatus } from '../monitoring/monitor-scheduler.js';

export type RpcStatus = 'up' | 'down';

export interface RpcHealth {
  status: RpcStatus;
  blockNumber: string | null;
  error: string | null;
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
}

export interface HeartbeatDependencies {
  getHttpLatestBlock: () => Promise<bigint>;
  getWsLatestBlock: () => Promise<bigint>;
}

interface RecoveryStatusProvider {
  readonly currentStatus: RecoveryCoordinatorStatus;
}

export class HeartbeatService {
  private snapshot: HeartbeatSnapshot | null = null;

  constructor(
    private readonly checkpoints: CheckpointRepository,
    private readonly sessions: SessionRepository,
    private readonly dependencies: HeartbeatDependencies,
    private readonly executionMode: ExecutionMode,
    private readonly recovery?: RecoveryStatusProvider,
  ) {}

  get currentSnapshot(): HeartbeatSnapshot | null {
    return this.snapshot;
  }

  async refresh(
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

    this.snapshot = {
      generatedAt: new Date().toISOString(),
      executionMode: this.executionMode,
      latestBlock,
      pairCreatedCheckpoint: pairCreatedCheckpoint === null ? null : pairCreatedCheckpoint.toString(),
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
    };

    return this.snapshot;
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
