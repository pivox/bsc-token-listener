import type { Address } from 'viem';
import { pancakeRouterAbi } from './abi/pancake-router.abi.js';
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
import { MonitorScheduler } from './monitoring/monitor-scheduler.js';
import { RecoveryCoordinator } from './recovery/recovery-coordinator.js';
import { RecoveryIntentService } from './recovery/recovery-intent.service.js';
import { ReconciliationRepository } from './recovery/reconciliation.repository.js';
import { SessionReconciler } from './recovery/session-reconciler.js';
import { ViemReconciliationGateway } from './recovery/viem-reconciliation.gateway.js';
import { RuntimeRecoveryBarrier } from './recovery/runtime-recovery-barrier.js';
import { account, publicClient, wsClient } from './rpc/clients.js';
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
  );
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
  const heartbeat = new HeartbeatService(
    checkpoints,
    sessions,
    {
      getHttpLatestBlock: () => publicClient.getBlockNumber(),
      getWsLatestBlock: () => wsClient.getBlockNumber(),
    },
    config.executionMode,
    recovery,
  );
  const monitors = new Map<string, SwapListener>();
  const activeSessionsByToken = new Map<string, TokenSession>();
  const activeTokenByPair = new Map<string, string>();
  let monitorSchedulingEnabled = true;
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
    if (scheduleNext && monitorSchedulingEnabled) requestMonitorReconcile();
  };

  const stopMonitor = (
    pair: Address,
    scheduleNext = true,
    logRelease = true,
  ): void => {
    const key = pair.toLowerCase();
    monitors.get(key)?.stop();
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
      checkpoints,
      events,
      engine,
      (pair) => removeMonitor(pair),
    );
    monitors.set(key, listener);
    activeSessionsByToken.set(tokenKey, session);
    activeTokenByPair.set(key, tokenKey);
    try {
      await listener.start();
    } catch (error) {
      listener.stop();
      removeMonitor(session.pair.pair, false, false);
      throw error;
    }
  };

  const monitorScheduler = new MonitorScheduler({
    capacity: config.maxActivePairMonitors,
    ttlMs: config.pairMonitorTtlMinutes * 60_000,
    loadSessions: () => sessions.loadActive(),
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
  requestMonitorReconcile = (): void => {
    if (recovery.currentStatus.running) return;
    void monitorScheduler.reconcile().catch((error: unknown) =>
      logger.error(
        { reason: errorMessage(error) },
        'Réconciliation de la file de monitoring échouée.',
      ));
  };

  synchronizeRecoveredSessions = async (): Promise<void> => {
    const refreshed = await sessions.loadActive();
    const refreshedByPair = new Map(
      refreshed.map((session) => [session.pair.pair.toLowerCase(), session]),
    );
    for (const [pairKey] of monitors) {
      const current = refreshedByPair.get(pairKey);
      if (!current) {
        stopMonitor(pairKey as Address, false);
        continue;
      }
      if (!isSessionMonitorable(current)) {
        stopMonitor(pairKey as Address, false);
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

  activateRecoveredSessions = async (): Promise<void> => {
    await monitorScheduler.reconcile();
  };

  const onPair = async (pair: PairInfo): Promise<void> => {
    const key = pair.pair.toLowerCase();
    if (monitors.has(key)) return;
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
    await monitorScheduler.reconcile();
  };

  const initialRecovery = await recovery.reconcileInitial();
  logger.info(
    { processedSessions: initialRecovery.processedSessions },
    'Réconciliation initiale terminée; activation des listeners autorisée.',
  );

  await monitorScheduler.reconcile();

  const pairListener = new PairCreatedListener(checkpoints, onPair);
  await pairListener.start();
  recovery.start();
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

  if (dashboard) {
    try {
      await dashboard.start();
    } catch (error) {
      logger.error(
        { reason: errorMessage(error), host: config.dashboardHost, port: config.dashboardPort },
        'Dashboard non démarré; le bot continue sans interface.',
      );
    }
  }

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
    monitorSchedulingEnabled = false;
    logger.info({ signal }, 'Arrêt du bot.');
    clearInterval(monitorQueueInterval);
    await recovery.stop();
    await monitorScheduler.waitForIdle();
    clearInterval(heartbeatInterval);
    pairListener.stop();
    for (const listener of monitors.values()) listener.stop();
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
