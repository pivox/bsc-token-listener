import type { Address } from 'viem';
import type { TokenSession } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import { isSessionMonitorable } from '../strategy/session-monitor-policy.js';

export interface MonitorSchedulerStatus {
  capacity: number;
  activeMonitors: number;
  waitingSessions: number;
  abandonedSessions: number;
  oldestWaitingAgeMs: number | null;
}

interface MonitorSchedulerDependencies {
  capacity: number;
  ttlMs: number;
  now?: () => number;
  loadSessions: () => Promise<TokenSession[]>;
  activePairs: () => readonly string[];
  isIgnored: (token: Address) => Promise<boolean>;
  expire: (session: TokenSession) => Promise<void>;
  ignore: (session: TokenSession) => Promise<void>;
  canStart?: () => boolean;
  start: (session: TokenSession) => Promise<void>;
  stop: (pair: Address) => void | Promise<void>;
}

function statusRank(status: TokenSession['status']): number {
  if (status === 'HOLDING') return 0;
  if (status === 'WAITING_FIRST_BUY') return 1;
  return 2;
}

export function compareMonitorPriority(
  left: TokenSession,
  right: TokenSession,
): number {
  const rankDifference = statusRank(left.status) - statusRank(right.status);
  if (rankDifference !== 0) return rankDifference;
  const ageDifference = left.createdAtMs - right.createdAtMs;
  if (ageDifference !== 0) return ageDifference;
  const leftPair = left.pair.pair.toLowerCase();
  const rightPair = right.pair.pair.toLowerCase();
  return leftPair < rightPair ? -1 : leftPair > rightPair ? 1 : 0;
}

export class MonitorScheduler {
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private rerunRequested = false;
  private status: MonitorSchedulerStatus;

  constructor(private readonly dependencies: MonitorSchedulerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.status = {
      capacity: dependencies.capacity,
      activeMonitors: 0,
      waitingSessions: 0,
      abandonedSessions: 0,
      oldestWaitingAgeMs: null,
    };
  }

  get currentStatus(): MonitorSchedulerStatus {
    return { ...this.status };
  }

  reconcile(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }

    this.running = this.runUntilStable();
    return this.running;
  }

  private async runUntilStable(): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        await this.runPass();
      } while (this.rerunRequested);
    } finally {
      this.running = null;
    }
  }

  private async runPass(): Promise<void> {
    const now = this.now();
    const sessions = await this.dependencies.loadSessions();
    const eligible: TokenSession[] = [];

    for (const session of sessions) {
      const pairKey = session.pair.pair.toLowerCase();
      if (
        session.status === 'WAITING_FIRST_BUY'
        && now - session.createdAtMs >= this.dependencies.ttlMs
      ) {
        await this.dependencies.expire(session);
        await this.stopIfActive(session.pair.pair);
        logger.info(
          { pair: session.pair.pair, waitingAgeMs: now - session.createdAtMs },
          'Session expirée dans la file de monitoring.',
        );
        continue;
      }

      if (
        session.status === 'WAITING_FIRST_BUY'
        && await this.dependencies.isIgnored(session.pair.token)
      ) {
        await this.dependencies.ignore(session);
        await this.stopIfActive(session.pair.pair);
        logger.info(
          { pair: session.pair.pair, token: session.pair.token },
          'Session retirée de la file de monitoring: actif ignoré.',
        );
        continue;
      }

      if (isSessionMonitorable(session)) eligible.push(session);
      else if (this.activePairKeys().has(pairKey)) {
        await this.dependencies.stop(session.pair.pair);
      }
    }

    const eligiblePairs = new Set(
      eligible.map((session) => session.pair.pair.toLowerCase()),
    );
    for (const activePair of this.dependencies.activePairs()) {
      if (eligiblePairs.has(activePair.toLowerCase())) continue;
      await this.dependencies.stop(activePair as Address);
      logger.info({ pair: activePair }, 'Capacité de monitoring libérée.');
    }

    eligible.sort(compareMonitorPriority);
    let abandonedSessions = 0;
    for (const session of eligible) {
      const activePairs = this.activePairKeys();
      const pairKey = session.pair.pair.toLowerCase();
      if (activePairs.has(pairKey)) continue;
      if (activePairs.size >= this.dependencies.capacity) break;
      if (this.dependencies.canStart && !this.dependencies.canStart()) break;

      try {
        await this.dependencies.start(session);
        if (!this.activePairKeys().has(pairKey)) {
          throw new Error('Le listener ne s’est pas déclaré actif.');
        }
        logger.info(
          { pair: session.pair.pair, status: session.status },
          'Session admise au monitoring.',
        );
      } catch (error) {
        abandonedSessions += 1;
        logger.warn(
          {
            pair: session.pair.pair,
            status: session.status,
            reason: errorMessage(error),
          },
          'Admission au monitoring échouée; poursuite de la file.',
        );
      }
    }

    const activePairs = this.activePairKeys();
    const waiting = eligible.filter(
      (session) => !activePairs.has(session.pair.pair.toLowerCase()),
    );
    const oldestWaitingAgeMs = waiting.length === 0
      ? null
      : Math.max(...waiting.map((session) => Math.max(0, now - session.createdAtMs)));

    this.status = {
      capacity: this.dependencies.capacity,
      activeMonitors: activePairs.size,
      waitingSessions: waiting.length,
      abandonedSessions,
      oldestWaitingAgeMs,
    };

    for (const session of waiting) {
      logger.info(
        {
          pair: session.pair.pair,
          status: session.status,
          capacity: this.status.capacity,
          activeMonitors: this.status.activeMonitors,
          waitingAgeMs: Math.max(0, now - session.createdAtMs),
        },
        'Session en attente de capacité de monitoring.',
      );
    }
  }

  private activePairKeys(): Set<string> {
    return new Set(
      this.dependencies.activePairs().map((pair) => pair.toLowerCase()),
    );
  }

  private async stopIfActive(pair: Address): Promise<void> {
    if (!this.activePairKeys().has(pair.toLowerCase())) return;
    await this.dependencies.stop(pair);
  }
}
