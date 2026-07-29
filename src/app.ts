import type { Address } from 'viem';
import { pancakeRouterAbi } from './abi/pancake-router.abi.js';
import {
  CanonicalChainCoordinator,
  type CanonicalReorgCompletion,
} from './chain/canonical-chain.coordinator.js';
import { CanonicalChainHealthProvider } from './chain/canonical-chain-health.provider.js';
import { CanonicalChainRepository } from './chain/canonical-chain.repository.js';
import { ReorgSessionReconciler } from './chain/reorg-session-reconciler.js';
import type { ReorgRollbackImpact } from './chain/canonical-chain.types.js';
import { chain } from './config/chain.js';
import { config } from './config/env.js';
import { ActionDashboardServer } from './dashboard/action-dashboard.js';
import { DashboardActionService } from './dashboard/dashboard-action.service.js';
import {
  DashboardRepository,
  DashboardService,
} from './dashboard/dashboard.js';
import { TokenMetadataService } from './discovery/token-metadata.service.js';
import { TradeExecutor } from './execution/trade-executor.js';
import { HeartbeatService } from './heartbeat/heartbeat.js';
import { PairCreatedListener } from './listeners/pair-created.listener.js';
import { SwapListener } from './listeners/swap.listener.js';
import { createMonitorReconcileRequest } from './monitoring/monitor-reconcile-request.js';
import { MonitorScheduler } from './monitoring/monitor-scheduler.js';
import { RecoveryCoordinator } from './recovery/recovery-coordinator.js';
import { RecoveryIntentService } from './recovery/recovery-intent.service.js';
import { ReconciliationRepository } from './recovery/reconciliation.repository.js';
import { SessionReconciler } from './recovery/session-reconciler.js';
import { ViemReconciliationGateway } from './recovery/viem-reconciliation.gateway.js';
import { RuntimeRecoveryBarrier } from './recovery/runtime-recovery-barrier.js';
import { account, publicClient, wsClient } from './rpc/clients.js';
import { drainRuntimeForShutdown } from './runtime/runtime-shutdown.js';
import {
  finalizeShallowReorgReplay,
  resumePersistedShallowReorgReplay,
} from './runtime/reorg-replay-lifecycle.js';
import { PendingShallowReorgQueue } from './runtime/pending-shallow-reorgs.js';
import { continueStartupAfterRecovery } from './runtime/startup-order.js';
import { RiskSettingsStore } from './security/risk-settings.store.js';
import { TokenRiskService } from './security/token-risk.service.js';
import { EntryAmountService } from './execution/entry-amount.service.js';
import { closeDatabase, migrate } from './storage/database.js';
import { IgnoredAssetRepository } from './storage/ignored-asset.repository.js';
import {
  CheckpointRepository,
  DiscoveredTokenRepository,
  RiskReportRepository,
  SessionRepository,
  SwapEventRepository,
  TradeRepository,
} from './storage/repositories.js';
import { SessionEngine } from './strategy/session-engine.js';
import { isSessionMonitorable } from './strategy/session-monitor-policy.js';
import type { PairInfo, TokenSession } from './types/domain.js';
import { errorMessage } from './utils/error.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== chain.id) {
    throw new Error(`RPC sur le mauvais réseau: attendu ${chain.id}, reçu ${chainId}.`);
  }

  const [routerFactory, routerWbnb] = await Promise.all([
    publicClient.readContract({
      address: config.router,
      abi: pancakeRouterAbi,
      functionName: 'factory',
    }),
    publicClient.readContract({
      address: config.router,
      abi: pancakeRouterAbi,
      functionName: 'WETH',
    }),
  ]);
  if (routerFactory.toLowerCase() !== config.factory.toLowerCase()) {
    throw new Error('La Factory configurée ne correspond pas au Router.');
  }
  if (routerWbnb.toLowerCase() !== config.wbnb.toLowerCase()) {
    throw new Error('WBNB configuré ne correspond pas au Router.');
  }

  if (config.autoMigrate) await migrate();

  const sessions = new SessionRepository();
  const events = new SwapEventRepository();
  const trades = new TradeRepository();
  const reports = new RiskReportRepository();
  const discovered = new DiscoveredTokenRepository();
  const checkpoints = new CheckpointRepository();
  const chainRepository = new CanonicalChainRepository();
  const ignoredAssets = new IgnoredAssetRepository();
  const riskSettings = new RiskSettingsStore();
  const metadataService = new TokenMetadataService(publicClient);
  const risk = new TokenRiskService(publicClient, riskSettings);
  const executor = new TradeExecutor(trades);
  const amountService = new EntryAmountService({
    getWalletBalanceWei: async () => {
      if (!account) return null;
      return publicClient.getBalance({ address: account.address });
    },
  });
  const runtimeRecoveryBarrier = new RuntimeRecoveryBarrier();
  const engine = new SessionEngine(
    sessions,
    reports,
    risk,
    executor,
    amountService,
    runtimeRecoveryBarrier,
    events,
  );
  const reorgSessions = new ReorgSessionReconciler({
    findSession: (pair) => sessions.findByPair(pair),
    listCanonicalProcessedEvents: (pair) =>
      events.listCanonicalProcessedEvents(pair),
    saveReconciledSession: (session, canonical) =>
      sessions.saveReconciledSession(session, canonical),
  });
  let synchronizeRecoveredSessions = async (): Promise<void> => {};
  let activateRecoveredSessions = async (): Promise<void> => {};
  const reconciliationStore = new ReconciliationRepository();
  const recoveryIntents = new RecoveryIntentService({
    reports,
    risk,
    amounts: amountService,
    positions: sessions,
    maxConcurrentPositions: config.maxConcurrentPositions,
    executor,
    riskPolicy: config.riskPolicy,
  });
  const recovery = new RecoveryCoordinator(
    reconciliationStore,
    new SessionReconciler(
      reconciliationStore,
      new ViemReconciliationGateway(),
      recoveryIntents,
    ),
    {
      intervalMs: config.recoveryIntervalSeconds * 1_000,
      leaseMs: config.recoveryLeaseSeconds * 1_000,
      staleAfterMs: config.recoveryStaleSeconds * 1_000,
      onPeriodicPassCompleted: () => synchronizeRecoveredSessions(),
      onPeriodicBarrierReleased: () => activateRecoveredSessions(),
    },
    runtimeRecoveryBarrier,
  );
  let chainHealthProvider: CanonicalChainHealthProvider | null = null;
  const heartbeat = new HeartbeatService(
    checkpoints,
    sessions,
    {
      getHttpLatestBlock: () => publicClient.getBlockNumber(),
      getWsLatestBlock: () => wsClient.getBlockNumber(),
    },
    config.executionMode,
    recovery,
    {
      confirmations: config.blockConfirmations,
      getHealth: (latestBlock) => {
        if (!chainHealthProvider) {
          throw new Error('Santé canonique indisponible pendant l’initialisation.');
        }
        return chainHealthProvider.getHealth(latestBlock);
      },
    },
  );
  const monitors = new Map<string, SwapListener>();
  const activeSessionsByToken = new Map<string, TokenSession>();
  const activeTokenByPair = new Map<string, string>();
  const monitorsPendingRecoveryDrain = new Map<string, SwapListener>();
  let pairListener: PairCreatedListener | null = null;
  const pendingShallowReorgs = new PendingShallowReorgQueue();
  let monitorSchedulingEnabled = false;
  let requestMonitorReconcile = (): void => {};

  const removeMonitor = (
    pair: Address,
    scheduleNext = true,
    logRelease = true,
  ): void => {
    const pairKey = pair.toLowerCase();
    const tokenKey = activeTokenByPair.get(pairKey);
    const removed = monitors.delete(pairKey);
    activeTokenByPair.delete(pairKey);
    if (tokenKey) activeSessionsByToken.delete(tokenKey);
    if (removed && logRelease) {
      logger.info({ pair }, 'Capacité de monitoring libérée.');
    }
    if (
      scheduleNext
      && monitorSchedulingEnabled
      && monitorsPendingRecoveryDrain.size === 0
    ) requestMonitorReconcile();
  };

  const stopMonitor = async (
    pair: Address,
    scheduleNext = true,
    logRelease = true,
  ): Promise<void> => {
    const key = pair.toLowerCase();
    await monitors.get(key)?.stopAndDrain();
    removeMonitor(pair, scheduleNext, logRelease);
  };

  const dashboardActions = new DashboardActionService(
    ignoredAssets,
    engine,
    (token) => activeSessionsByToken.get(token.toLowerCase()) ?? null,
    (pair) => stopMonitor(pair),
  );
  const dashboard = config.dashboardEnabled
    ? new ActionDashboardServer(
      new DashboardService(new DashboardRepository(), heartbeat),
      riskSettings,
      dashboardActions,
    )
    : null;

  const startMonitor = async (session: TokenSession): Promise<void> => {
    if (!isSessionMonitorable(session)) return;
    const key = session.pair.pair.toLowerCase();
    const tokenKey = session.pair.token.toLowerCase();
    if (monitors.has(key)) return;
    const listener = new SwapListener(
      session,
      engine,
      (pair) => removeMonitor(pair),
      {
        watcher: wsClient,
        logReader: publicClient,
        coordinator: canonicalCoordinator,
      },
    );
    monitors.set(key, listener);
    activeSessionsByToken.set(tokenKey, session);
    activeTokenByPair.set(key, tokenKey);
    try {
      await listener.start();
    } catch (error) {
      await listener.stopAndDrain();
      removeMonitor(session.pair.pair, false, false);
      throw error;
    }
  };

  const monitorScheduler = new MonitorScheduler({
    capacity: config.maxActivePairMonitors,
    ttlMs: config.pairMonitorTtlMinutes * 60_000,
    loadSessions: () => sessions.loadActive(),
    loadSession: (pair) => sessions.findByPair(pair),
    activePairs: () => [...monitors.keys()],
    isIgnored: (token) => ignoredAssets.isIgnored(token),
    expire: async (session) => {
      await engine.expireIfNeeded(session);
    },
    ignore: async (session) => {
      await engine.ignoreManually(session);
    },
    canStart: () =>
      monitorSchedulingEnabled && !recovery.currentStatus.running,
    start: startMonitor,
    stop: (pair) => stopMonitor(pair, false, false),
  });
  requestMonitorReconcile = createMonitorReconcileRequest({
    canSchedule: () =>
      monitorSchedulingEnabled
      && !recovery.currentStatus.running
      && monitorsPendingRecoveryDrain.size === 0,
    reconcile: async () => {
      const result = await monitorScheduler.reconcile();
      if (result.failedPairs.length > 0) {
        throw new Error(
          `Démarrage de ${result.failedPairs.length} listener(s) Swap échoué.`,
        );
      }
    },
    onError: (error) => logger.error(
      { reason: errorMessage(error) },
      'Réconciliation de la file de monitoring échouée.',
    ),
  });

  synchronizeRecoveredSessions = async (): Promise<void> => {
    const refreshed = await sessions.loadActive();
    const refreshedByPair = new Map(
      refreshed.map((session) => [session.pair.pair.toLowerCase(), session]),
    );
    for (const [pairKey] of monitors) {
      const current = refreshedByPair.get(pairKey);
      if (!current) {
        const listener = monitors.get(pairKey);
        listener?.stop();
        if (listener) monitorsPendingRecoveryDrain.set(pairKey, listener);
        continue;
      }
      if (!isSessionMonitorable(current)) {
        const listener = monitors.get(pairKey);
        listener?.stop();
        if (listener) monitorsPendingRecoveryDrain.set(pairKey, listener);
        refreshedByPair.delete(pairKey);
        continue;
      }
      const active = activeSessionsByToken.get(current.pair.token.toLowerCase());
      if (active) {
        for (const key of Object.keys(active)) Reflect.deleteProperty(active, key);
        Object.assign(active, structuredClone(current));
      }
      refreshedByPair.delete(pairKey);
    }
  };

  const reconcileRollbackProjections = async (
    rollback: ReorgRollbackImpact,
  ): Promise<void> => {
    const reconciliation = await reorgSessions.reconcile(rollback);
    for (const pair of reconciliation.monitorsToStop) {
      const pairKey = pair.toLowerCase();
      const listener = monitors.get(pairKey);
      listener?.stop();
      if (listener) {
        monitorsPendingRecoveryDrain.set(pairKey, listener);
      }
    }
    await synchronizeRecoveredSessions();
  };

  activateRecoveredSessions = async (): Promise<void> => {
    const pending = [...monitorsPendingRecoveryDrain.entries()];
    await Promise.all(
      pending.map(([, listener]) => listener.stopAndDrain()),
    );
    for (const [pairKey] of pending) {
      removeMonitor(pairKey as Address, false);
      monitorsPendingRecoveryDrain.delete(pairKey);
    }
    await monitorScheduler.reconcile();
  };

  const canonicalCoordinator = new CanonicalChainCoordinator({
    blockReader: {
      getBlockNumber: () => publicClient.getBlockNumber(),
      getBlock: async (blockNumber) => {
        const block = await publicClient.getBlock({ blockNumber });
        if (block.number === null || block.hash === null) {
          throw new Error(
            `Header RPC incomplet pour le bloc ${blockNumber}.`,
          );
        }
        return {
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
        };
      },
    },
    canonicalStore: chainRepository,
    checkpoints,
    confirmations: config.blockConfirmations,
    runtimeBarrier: runtimeRecoveryBarrier,
    reorgHandler: {
      reconcileReorg: async (reorg) => {
        if (!reorg.ancestor) {
          await runtimeRecoveryBarrier.runRecovery(async () => {
            await chainRepository.recordDeepReorg(
              reorg,
              'NO_COMMON_ANCESTOR_WITHIN_RETENTION',
            );
          });
          return {
            depth: null,
            orphanedEvents: 0,
            replayedEvents: 0,
          };
        }

        const impact = await runtimeRecoveryBarrier.runRecovery(async () => {
          const rollback = await chainRepository.rewindToAncestor(reorg);
          await reconcileRollbackProjections(rollback);
          if (rollback.affectedPairs.some((pair) => pair.hasWalletConsequence)) {
            await chainRepository.requireManualReview(
              rollback.reorgId,
              'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
            );
            return { ...rollback, requiresManualReview: true };
          }
          pendingShallowReorgs.enqueue({
            identity: `${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`,
            impact: rollback,
          });
          return rollback;
        });
        return impact;
      },
    },
    afterReorg: async (state) => {
      if (state !== 'RECONCILING') return undefined;
      return pendingShallowReorgs.finalizeHead(async (pending) => {
        const replayAndFinalize = (impact: ReorgRollbackImpact) =>
          finalizeShallowReorgReplay(impact, {
            activateRecoveredSessions,
            reconcilePairs: async () => pairListener?.reconcileNow(),
            waitForMonitorIdle: () => monitorScheduler.waitForIdle(),
            reconcileActiveSwaps: async () => {
              await Promise.all(
                [...monitors.values()].map((listener) => listener.reconcileNow()),
              );
            },
            countCanonicalProcessedEvents: (eventIds) =>
              chainRepository.countCanonicalProcessedEvents(eventIds),
            completeReorg: (reorgId, replayedEvents) =>
              chainRepository.completeReorg(reorgId, replayedEvents),
          });
        const replayedEvents = pending.requiresProjectionReconciliation === true
          ? await resumePersistedShallowReorgReplay(pending.impact, {
              reconcileProjections: (impact) =>
                runtimeRecoveryBarrier.runRecovery(
                  () => reconcileRollbackProjections(impact),
                ),
              requireManualReview: (reorgId) =>
                chainRepository.requireManualReview(
                  reorgId,
                  'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
                ),
              replayAndFinalize,
            })
          : await replayAndFinalize(pending.impact);
        if (replayedEvents === null) {
          canonicalCoordinator.requireManualReviewForPendingReorg(
            pending.identity,
            pending.impact.reorgId,
          );
          return undefined;
        }
        const completion: CanonicalReorgCompletion = {
          identity: pending.identity,
          reorgId: pending.impact.reorgId,
          replayedEvents,
        };
        return completion;
      });
    },
  });
  chainHealthProvider = new CanonicalChainHealthProvider(
    config.blockConfirmations,
    canonicalCoordinator,
    chainRepository,
  );

  const onPair = async (pair: PairInfo): Promise<void> => {
    const key = pair.pair.toLowerCase();
    if (monitors.has(key)) return;
    const existing = await sessions.findByPair(pair.pair);
    if (existing) {
      requestMonitorReconcile();
      return;
    }
    if (await ignoredAssets.isIgnored(pair.token)) {
      logger.info(
        { pair: pair.pair, token: pair.token },
        'Paire ignorée: le token figure dans la liste d’ignorance.',
      );
      return;
    }

    await discovered.upsert({ pair, source: 'PAIR_CREATED' });
    let metadata;
    try {
      metadata = await metadataService.read(pair.token);
    } catch (error) {
      logger.warn(
        { pair: pair.pair, token: pair.token, reason: errorMessage(error) },
        'Nouvelle paire ignorée: contrat non compatible BEP-20 minimal.',
      );
      return;
    }
    await discovered.upsert({ pair, metadata, source: 'PAIR_CREATED' });

    const now = Date.now();
    const session: TokenSession = {
      pair,
      metadata,
      status: 'WAITING_FIRST_BUY',
      entryObservationBuys: [],
      subsequentBuyCount: 0,
      targetBuysAfterEntry: config.targetBuysAfterEntry,
      countedBuyTransactionHashes: [],
      sellAttempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await sessions.save(session);
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
    requestMonitorReconcile();
  };

  const initialRecovery = await recovery.reconcileInitial();
  logger.info(
    { processedSessions: initialRecovery.processedSessions },
    'Réconciliation initiale terminée.',
  );

  pairListener = new PairCreatedListener(onPair, {
    watcher: wsClient,
    logReader: publicClient,
    coordinator: canonicalCoordinator,
  });
  await continueStartupAfterRecovery({
    startDashboard: async () => {
      await dashboard?.start();
    },
    onDashboardError: (error) => {
      logger.error(
        { reason: errorMessage(error), host: config.dashboardHost, port: config.dashboardPort },
        'Dashboard non démarré; le bot continue sans interface.',
      );
    },
    hydrateCanonicalRecovery: async () => {
      const persisted = await chainRepository.listPendingShallowReorgs();
      if (persisted.length === 0) return;
      const hydrated = persisted.map(({ audit, rollbackImpact }) => {
        if (audit.commonAncestor === null) {
          throw new Error('Audit RECONCILING shallow sans ancêtre commun.');
        }
        const identity = `${audit.previousTip.hash.toLowerCase()}:${audit.replacementTip.hash.toLowerCase()}`;
        if (rollbackImpact.reorgId !== `reorg:${identity}`) {
          throw new Error('Audit shallow persistant associé à un fork incohérent.');
        }
        pendingShallowReorgs.enqueue({
          identity,
          impact: rollbackImpact,
          requiresProjectionReconciliation: true,
        });
        return {
          reorgId: rollbackImpact.reorgId,
          detectedAtMs: audit.detectedAtMs,
          ancestor: audit.commonAncestor,
          oldTip: audit.previousTip,
          newTip: audit.replacementTip,
          impact: rollbackImpact,
        };
      });
      canonicalCoordinator.hydratePendingReorgs(hydrated);
    },
    synchronizeCanonical: async () => {
      await canonicalCoordinator.reconcile({
        listenerKey: 'canonical-startup-sync',
        startBlock: (1n << 256n) - 1n,
        processChunk: async () => {
          throw new Error(
            'La synchronisation canonique initiale ne doit traiter aucun log.',
          );
        },
      });
      monitorSchedulingEnabled = true;
      await monitorScheduler.reconcile();
    },
    activateListeners: async () => {
      await pairListener.start();
      recovery.start();
    },
    cleanup: {
      disableSchedulingAndStopNewWork: () => {
        monitorSchedulingEnabled = false;
        pairListener.stop();
        for (const listener of monitors.values()) listener.stop();
      },
      stopRecovery: () => recovery.stop(),
      waitForMonitorIdle: () => monitorScheduler.waitForIdle(),
      waitForCanonicalIdle: () => canonicalCoordinator.waitForIdle(),
      drainListeners: async () => {
        await Promise.all(
          [...monitors.values()].map((listener) => listener.stopAndDrain()),
        );
      },
      stopDashboard: async () => {
        await dashboard?.stop();
      },
      closeDatabase,
      onCleanupError: (error) => {
        logger.warn(
          { reason: errorMessage(error) },
          'Nettoyage du démarrage incomplet.',
        );
      },
    },
  });
  const monitorQueueInterval = setInterval(() => {
    requestMonitorReconcile();
  }, config.reconcileSeconds * 1_000);
  monitorQueueInterval.unref();

  const refreshHeartbeat = async (): Promise<void> => {
    const snapshot = await heartbeat.refresh(
      monitors.size,
      monitorScheduler.currentStatus,
    );
    logger.info(
      {
        latestBlock: snapshot.latestBlock,
        pairCreatedCheckpoint: snapshot.pairCreatedCheckpoint,
        activeSwapMonitors: snapshot.activeSwapMonitors,
        activeSessions: snapshot.activeSessions,
        monitorCapacity: snapshot.monitoring.capacity,
        waitingMonitorSessions: snapshot.monitoring.waitingSessions,
        abandonedMonitorSessions: snapshot.monitoring.abandonedSessions,
        oldestMonitorWaitingAgeMs: snapshot.monitoring.oldestWaitingAgeMs,
        executionMode: snapshot.executionMode,
        httpStatus: snapshot.http.status,
        wsStatus: snapshot.webSocket.status,
        recoveryRunning: snapshot.recovery.running,
        recoveryPendingSessions: snapshot.recovery.pendingSessions,
        recoveryManualReviewSessions: snapshot.recovery.manualReviewSessions,
        recoveryLastCompletedAt: snapshot.recovery.lastCompletedAt,
        recoveryLastErrorType: snapshot.recovery.lastErrorType,
        chainConfirmations: snapshot.chain.confirmations,
        chainConfirmedHead: snapshot.chain.confirmedHead,
        canonicalBlockNumber: snapshot.chain.canonicalBlockNumber,
        canonicalBlockHash: snapshot.chain.canonicalBlockHash,
        chainState: snapshot.chain.state,
        chainStale: snapshot.chain.stale,
        lastReorg: snapshot.chain.lastReorg,
      },
      'Heartbeat.',
    );
  };
  await refreshHeartbeat().catch((error: unknown) =>
    logger.error({ reason: errorMessage(error) }, 'Heartbeat initial échoué.'),
  );
  const heartbeatInterval = setInterval(() => {
    void refreshHeartbeat().catch((error: unknown) =>
      logger.error({ reason: errorMessage(error) }, 'Heartbeat échoué.'));
  }, 60_000);

  const currentRiskSettings = await riskSettings.get();
  logger.info(
    {
      network: config.network,
      executionMode: config.executionMode,
      riskPolicy: config.riskPolicy,
      allowUnknownReviews: currentRiskSettings.allowUnknownReviews,
      allowUnknownMinScore: currentRiskSettings.allowUnknownMinScore,
      factory: config.factory,
      router: config.router,
      wbnb: config.wbnb,
      activePairMonitors: monitors.size,
      targetBuysAfterEntry: config.targetBuysAfterEntry,
      dashboardEnabled: config.dashboardEnabled,
      dashboardUrl: config.dashboardEnabled
        ? `http://${config.dashboardHost}:${config.dashboardPort}/dashboard`
        : null,
    },
    config.executionMode === 'dry-run'
      ? 'Bot démarré en dry-run: aucune transaction ne sera envoyée.'
      : 'Bot démarré en mode live.',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Arrêt du bot.');
    await drainRuntimeForShutdown({
      disableSchedulingAndStopNewWork: () => {
        monitorSchedulingEnabled = false;
        clearInterval(monitorQueueInterval);
        clearInterval(heartbeatInterval);
        pairListener.stop();
        for (const listener of monitors.values()) listener.stop();
      },
      stopRecovery: () => recovery.stop(),
      waitForMonitorIdle: () => monitorScheduler.waitForIdle(),
      waitForCanonicalIdle: () => canonicalCoordinator.waitForIdle(),
    });
    await Promise.all(
      [...monitors.values()].map((listener) => listener.stopAndDrain()),
    );
    try {
      await dashboard?.stop();
    } catch (error) {
      logger.warn({ reason: errorMessage(error) }, 'Arrêt du dashboard incomplet.');
    }
    await closeDatabase();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.fatal({ error: errorMessage(error) }, 'Démarrage impossible.');
  process.exitCode = 1;
});
