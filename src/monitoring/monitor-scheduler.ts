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

export interface MonitorReconcileResult {
  failedPairs: Address[];
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

function preservesMonitorReservation(status: TokenSession['status']): boolean {
  return ['RISK_CHECKING', 'BUY_PENDING', 'SELL_PENDING'].includes(status);
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
  private running: Promise<MonitorReconcileResult> | null = null;
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

  waitForIdle(): Promise<void> {
    return this.running?.then(() => undefined) ?? Promise.resolve();
  }

  reconcile(): Promise<MonitorReconcileResult> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }

    this.running = this.runUntilStable();
    return this.running;
  }

  private async runUntilStable(): Promise<MonitorReconcileResult> {
    const failedPairs = new Set<Address>();
    try {
      do {
        this.rerunRequested = false;
        for (const pair of await this.runPass()) failedPairs.add(pair);
      } while (this.rerunRequested);
      return { failedPairs: [...failedPairs] };
    } finally {
      this.running = null;
    }
  }

  private async runPass(): Promise<Address[]> {
    const now = this.now();
    const sessions = await this.dependencies.loadSessions();
    const eligible: TokenSession[] = [];
    const reservedPairs = new Set<string>();

    for (const session of sessions) {
      const pairKey = session.pair.pair.toLowerCase();
      const isActive = this.activePairKeys().has(pairKey);
      if (
        session.status === 'WAITING_FIRST_BUY'
        && now - session.createdAtMs >= this.dependencies.ttlMs
      ) {
        if (!isActive) {
          await this.dependencies.expire(session);
          logger.info(
            { pair: session.pair.pair, waitingAgeMs: now - session.createdAtMs },
            'Session expirée dans la file de monitoring.',
          );
          continue;
        }
      }

      if (
        session.status === 'WAITING_FIRST_BUY'
        && await this.dependencies.isIgnored(session.pair.token)
      ) {
        if (isActive) {
          await this.dependencies.stop(session.pair.pair);
          this.rerunRequested = true;
        } else {
          await this.dependencies.ignore(session);
        }
        logger.info(
          { pair: session.pair.pair, token: session.pair.token },
          'Session retirée de la file de monitoring: actif ignoré.',
        );
        continue;
      }

      if (isSessionMonitorable(session)) eligible.push(session);
      else if (isActive && preservesMonitorReservation(session.status)) {
        reservedPairs.add(pairKey);
      }
      else if (this.activePairKeys().has(pairKey)) {
        await this.dependencies.stop(session.pair.pair);
      }
    }

    const eligiblePairs = new Set(
      [
        ...reservedPairs,
        ...eligible.map((session) => session.pair.pair.toLowerCase()),
      ],
    );
    for (const activePair of this.dependencies.activePairs()) {
      if (eligiblePairs.has(activePair.toLowerCase())) continue;
      await this.dependencies.stop(activePair as Address);
      logger.info({ pair: activePair }, 'Capacité de monitoring libérée.');
    }

    eligible.sort(compareMonitorPriority);
    let abandonedSessions = 0;
    let reservedFailedHoldingSlots = 0;
    const failedPairs: Address[] = [];
    for (const session of eligible) {
      let activePairs = this.activePairKeys();
      const pairKey = session.pair.pair.toLowerCase();
      if (activePairs.has(pairKey)) continue;
      if (this.dependencies.canStart && !this.dependencies.canStart()) break;
      if (
        activePairs.size + reservedFailedHoldingSlots
        >= this.dependencies.capacity
      ) {
        const preempted = session.status === 'HOLDING'
          ? this.lowestPriorityActiveObservation(eligible)
          : null;
        if (!preempted) break;
        await this.dependencies.stop(preempted.pair.pair);
        logger.info(
          {
            pair: preempted.pair.pair,
            preemptedBy: session.pair.pair,
          },
          'Moniteur d’observation libéré pour une position ouverte.',
        );
        this.rerunRequested = true;
        activePairs = this.activePairKeys();
      }

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
        failedPairs.push(session.pair.pair);
        if (session.status === 'HOLDING') reservedFailedHoldingSlots += 1;
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
    return failedPairs;
  }

  private activePairKeys(): Set<string> {
    return new Set(
      this.dependencies.activePairs().map((pair) => pair.toLowerCase()),
    );
  }

  private lowestPriorityActiveObservation(
    eligible: readonly TokenSession[],
  ): TokenSession | null {
    const activePairs = this.activePairKeys();
    return eligible
      .filter(
        (session) =>
          session.status === 'WAITING_FIRST_BUY'
          && activePairs.has(session.pair.pair.toLowerCase()),
      )
      .sort(compareMonitorPriority)
      .at(-1) ?? null;
  }
}
