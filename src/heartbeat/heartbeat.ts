import { errorMessage } from '../utils/error.js';
import type { CheckpointRepository, SessionRepository } from '../storage/repositories.js';
import type { ExecutionMode } from '../types/domain.js';

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
  http: RpcHealth;
  webSocket: RpcHealth;
}

export interface HeartbeatDependencies {
  getHttpLatestBlock: () => Promise<bigint>;
  getWsLatestBlock: () => Promise<bigint>;
}

export class HeartbeatService {
  private snapshot: HeartbeatSnapshot | null = null;

  constructor(
    private readonly checkpoints: CheckpointRepository,
    private readonly sessions: SessionRepository,
    private readonly dependencies: HeartbeatDependencies,
    private readonly executionMode: ExecutionMode,
  ) {}

  get currentSnapshot(): HeartbeatSnapshot | null {
    return this.snapshot;
  }

  async refresh(activeSwapMonitors: number): Promise<HeartbeatSnapshot> {
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
      http,
      webSocket,
    };

    return this.snapshot;
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
