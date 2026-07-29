import type { Address } from 'viem';
import { pancakeRouterAbi } from './abi/pancake-router.abi.js';
import { pancakePairAbi } from './abi/pancake-pair.abi.js';
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
import { ExitPolicyDashboardService } from './dashboard/exit-policy.service.js';
import {
  DashboardRepository,
  DashboardService,
} from './dashboard/dashboard.js';
import { TokenMetadataService } from './discovery/token-metadata.service.js';
import { restoreReappearedPairSession } from './discovery/reappeared-pair.js';
import { TradeExecutor } from './execution/trade-executor.js';
import { HeartbeatService } from './heartbeat/heartbeat.js';
import { PairCreatedListener } from './listeners/pair-created.listener.js';
import { SwapListener } from './listeners/swap.listener.js';
import { createMonitorReconcileRequest } from './monitoring/monitor-reconcile-request.js';
import {
  MonitorScheduler,
  type MonitorReconcileResult,
} from './monitoring/monitor-scheduler.js';
import { RecoveryCoordinator } from './recovery/recovery-coordinator.js';
import { RecoveryIntentService } from './recovery/recovery-intent.service.js';
import { ReconciliationRepository } from './recovery/reconciliation.repository.js';
import { SessionReconciler } from './recovery/session-reconciler.js';
import { ViemReconciliationGateway } from './recovery/viem-reconciliation.gateway.js';
import { RuntimeRecoveryBarrier } from './recovery/runtime-recovery-barrier.js';
import { account, publicClient, wsClient } from './rpc/clients.js';
import { drainRuntimeForShutdown } from './runtime/runtime-shutdown.js';
import { FreshStartRepository } from './runtime/fresh-start.repository.js';
import { FreshStartService } from './runtime/fresh-start.service.js';
import { startPositionExitRuntime } from './runtime/position-exit-runtime.js';
import {
  ReorgReplayAdmissionGate,
  startSwapMonitorForAdmission,
} from './runtime/reorg-monitor-admission.js';
import { retireTerminalMonitor } from './runtime/terminal-monitor-retirement.js';
import {
  finalizeShallowReorgReplay,
  resumePersistedShallowReorgReplay,
} from './runtime/reorg-replay-lifecycle.js';
import { PendingShallowReorgQueue } from './runtime/pending-shallow-reorgs.js';
import { continueStartupAfterRecovery } from './runtime/startup-order.js';
import { RiskSettingsStore } from './security/risk-settings.store.js';
import { TokenRiskService } from './security/token-risk.service.js';
import { SafetyProbeService } from './security/safety-probe.service.js';
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
import { PositionExitRepository } from './strategy/position-exit.repository.js';
import { PositionExitSettingsProvider } from './strategy/position-exit-settings.provider.js';
import { PositionMetricsService } from './strategy/position-metrics.service.js';
import { PositionExitMonitor } from './strategy/position-exit-monitor.js';
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

  const canonicalBlockReader = {
    getBlockNumber: () => publicClient.getBlockNumber(),
    getBlock: async (blockNumber: bigint) => {
      const block = await publicClient.getBlock({ blockNumber });
      if (
        block.number === null
        || block.hash === null
        || block.number !== blockNumber
      ) {
        throw new Error(`Header RPC incomplet pour le bloc ${blockNumber}.`);
      }
      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
      };
    },
  };
  const freshStartService = new FreshStartService(
    canonicalBlockReader,
    new FreshStartRepository(),
    config.blockConfirmations,
  );
  const freshStartRun = await freshStartService.apply();
  logger.warn(
    {
      cutoffBlock: freshStartRun.cutoff.number.toString(),
      cutoffHash: freshStartRun.cutoff.hash,
      quarantinedSessions: freshStartRun.quarantinedSessions,
      quarantinedDecisions: freshStartRun.quarantinedDecisions,
    },
    'Fresh-start appliqué; historique antérieur placé en revue manuelle.',
  );

  const sessions = new SessionRepository();
  const events = new SwapEventRepository();
  const trades = new TradeRepository();
  const reports = new RiskReportRepository();
  const discovered = new DiscoveredTokenRepository();
  const checkpoints = new CheckpointRepository();
  const chainRepository = new CanonicalChainRepository();
  const ignoredAssets = new IgnoredAssetRepository();
  const positionExitRepository = new PositionExitRepository();
  const positionExitSettings = new PositionExitSettingsProvider(
    positionExitRepository,
    config.positionExitSettings,
  );
  const riskSettings = new RiskSettingsStore();
  const metadataService = new TokenMetadataService(publicClient);
  const safetyProbe = new SafetyProbeService(publicClient);
  const risk = new TokenRiskService(publicClient, riskSettings, safetyProbe);
  const executor = new TradeExecutor(trades);
  const amountService = new EntryAmountService({
    getWalletBalanceWei: async () => {
      if (!account) return null;
      return publicClient.getBalance({ address: account.address });
    },
  });
  const runtimeRecoveryBarrier = new RuntimeRecoveryBarrier();
  const positionMetrics = new PositionMetricsService({
    quotePosition: async (session) => {
      if (!session.entry) throw new Error('Position sans entrée.');
      const amounts = await publicClient.readContract({
        address: session.pair.router,
        abi: pancakeRouterAbi,
        functionName: 'getAmountsOut',
        args: [
          session.entry.amountOutToken,
          [session.pair.token, session.pair.wbnb],
        ],
      });
      const quote = amounts.at(-1);
      if (quote === undefined) throw new Error('Quote de sortie vide.');
      return quote;
    },
    readLiquidityWbnb: async (session) => {
      const [reserve0, reserve1] = await publicClient.readContract({
        address: session.pair.pair,
        abi: pancakePairAbi,
        functionName: 'getReserves',
      });
      return session.pair.token0.toLowerCase() ===
        session.pair.wbnb.toLowerCase()
        ? reserve0
        : reserve1;
    },
    readFeePerGas: () => publicClient.getGasPrice(),
    probeSellability: (session) => safetyProbe.probe(session.pair),
  });
  const engine = new SessionEngine(
    sessions,
    reports,
    risk,
    executor,
    amountService,
    runtimeRecoveryBarrier,
    events,
    {
      settings: positionExitSettings,
      metrics: positionMetrics,
      decisions: positionExitRepository,
    },
  );
  const positionExitMonitor = new PositionExitMonitor({
    sessions,
    settings: positionExitSettings,
    metrics: positionMetrics,
    decisions: positionExitRepository,
    engine,
    barrier: runtimeRecoveryBarrier,
  });
  const reorgSessions = new ReorgSessionReconciler({
    findSession: (pair) => sessions.findByPair(pair),
    listCanonicalProcessedEvents: (pair) =>
      events.listCanonicalProcessedEvents(pair),
    saveReconciledSession: (session, canonical) =>
      sessions.saveReconciledSession(session, canonical),
  });
  let synchronizeRecoveredSessions = async (): Promise<void> => {};
  let activateRecoveredSessions = async (): Promise<void> => {};
  let admitReorgReplaySessions =
    async (): Promise<MonitorReconcileResult> => ({ failedPairs: [] });
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
  const terminalPairsPendingRetirement = new Set<string>();
  const terminalRetirementOperations = new Map<string, Promise<void>>();
  let pairListener: PairCreatedListener | null = null;
  const pendingShallowReorgs = new PendingShallowReorgQueue();
  let monitorSchedulingEnabled = false;
  const reorgReplayAdmission = new ReorgReplayAdmissionGate();
  const monitorsAwaitingReplayActivation = new Set<string>();
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
    if (terminalPairsPendingRetirement.has(key)) {
      await retireTerminalPair(pair);
      return;
    }
    await monitors.get(key)?.stopAndDrain();
    removeMonitor(pair, scheduleNext, logRelease);
  };

  const retireTerminalPair = (pair: Address): Promise<void> => {
    const key = pair.toLowerCase();
    const existing = terminalRetirementOperations.get(key);
    if (existing) return existing;
    terminalPairsPendingRetirement.add(key);
    const operation = retireTerminalMonitor(pair, {
      stopAndDrain: async () => {
        await monitors.get(key)?.stopAndDrain();
      },
      deleteCheckpoint: (listenerKey) => checkpoints.delete(listenerKey),
      releaseCapacity: () => {
        terminalPairsPendingRetirement.delete(key);
        monitorsAwaitingReplayActivation.delete(key);
        removeMonitor(pair);
      },
    }).finally(() => {
      terminalRetirementOperations.delete(key);
    });
    terminalRetirementOperations.set(key, operation);
    return operation;
  };

  const dashboardActions = new DashboardActionService(
    ignoredAssets,
    engine,
    (token) => activeSessionsByToken.get(token.toLowerCase()) ?? null,
    (pair) => stopMonitor(pair),
  );
  const exitPolicyDashboard = new ExitPolicyDashboardService(
    positionExitSettings,
    sessions,
    config.positionExitSettings,
  );
  const dashboard = config.dashboardEnabled
    ? new ActionDashboardServer(
      new DashboardService(
        new DashboardRepository(),
        heartbeat,
        positionExitSettings,
      ),
      riskSettings,
      dashboardActions,
      exitPolicyDashboard,
    )
    : null;

  const startMonitor = async (session: TokenSession): Promise<boolean> => {
    if (!isSessionMonitorable(session)) return false;
    const key = session.pair.pair.toLowerCase();
    const tokenKey = session.pair.token.toLowerCase();
    if (monitors.has(key)) return true;
    const listener = new SwapListener(
      session,
      engine,
      (pair) => {
        void retireTerminalPair(pair).catch((error: unknown) => {
          logger.error(
            { pair, reason: errorMessage(error) },
            'Retrait terminal du listener Swap échoué.',
          );
        });
      },
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
      const started = await startSwapMonitorForAdmission(
        listener,
        reorgReplayAdmission,
      );
      if (!started) {
        await listener.stopAndDrain();
        removeMonitor(session.pair.pair, false, false);
        return false;
      }
      if (reorgReplayAdmission.isActive) {
        monitorsAwaitingReplayActivation.add(key);
      }
      return true;
    } catch (error) {
      await listener.stopAndDrain();
      monitorsAwaitingReplayActivation.delete(key);
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
      reorgReplayAdmission.canStartMonitor(monitorSchedulingEnabled)
      && !recovery.currentStatus.running,
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

  const drainRecoveredMonitors = async (): Promise<void> => {
    const pending = [...monitorsPendingRecoveryDrain.entries()];
    await Promise.all(
      pending.map(([, listener]) => listener.stopAndDrain()),
    );
    for (const [pairKey] of pending) {
      removeMonitor(pairKey as Address, false);
      monitorsPendingRecoveryDrain.delete(pairKey);
    }
  };

  activateRecoveredSessions = async (): Promise<void> => {
    await drainRecoveredMonitors();
    const result = await monitorScheduler.reconcile();
    if (result.failedPairs.length > 0) {
      throw new Error(
        `Démarrage de ${result.failedPairs.length} listener(s) Swap échoué.`,
      );
    }
  };

  admitReorgReplaySessions = async (): Promise<MonitorReconcileResult> => {
    return monitorScheduler.reconcile();
  };

  const canonicalCoordinator = new CanonicalChainCoordinator({
    blockReader: canonicalBlockReader,
    canonicalStore: chainRepository,
    checkpoints,
    confirmations: config.blockConfirmations,
    cutoff: freshStartRun.cutoff,
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
            withReplayAdmission: (operation) =>
              reorgReplayAdmission.run(operation),
            prepareRecoveredSessions: drainRecoveredMonitors,
            activateRecoveredSessions: admitReorgReplaySessions,
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
    onRecovered: () => {
      for (const key of monitorsAwaitingReplayActivation) {
        monitors.get(key)?.activateAfterReplay();
      }
      monitorsAwaitingReplayActivation.clear();
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
      const restored = restoreReappearedPairSession(existing, pair, Date.now());
      if (restored) {
        await discovered.upsert({
          pair,
          metadata: restored.metadata,
          source: 'PAIR_CREATED',
        });
        await sessions.save(restored);
        requestMonitorReconcile();
        return;
      }
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
    prepareListenerCheckpoints: async () => {
      const removed =
        await checkpoints.deleteNonMonitorableSwapCheckpoints();
      if (removed > 0) {
        logger.info(
          { removed },
          'Checkpoints Swap terminaux nettoyés au démarrage.',
        );
      }
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
      await startPositionExitRuntime({
        reconcilePendingDecisions: () =>
          positionExitMonitor.reconcilePendingDecisions(),
        reconcileNow: () => positionExitMonitor.reconcileNow(),
        start: () => positionExitMonitor.start(),
      });
      await pairListener.start();
      recovery.start();
    },
    cleanup: {
      disableSchedulingAndStopNewWork: () => {
        monitorSchedulingEnabled = false;
        positionExitMonitor.stop();
        pairListener.stop();
        for (const listener of monitors.values()) listener.stop();
      },
      stopRecovery: () => recovery.stop(),
      waitForMonitorIdle: async () => {
        await positionExitMonitor.waitForIdle();
        await monitorScheduler.waitForIdle();
      },
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
      stopPositionExits: () => positionExitMonitor.stop(),
      stopRecovery: () => recovery.stop(),
      waitForPositionExitIdle: () => positionExitMonitor.waitForIdle(),
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
