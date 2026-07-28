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
import { publicClient, wsClient } from './rpc/clients.js';
import { RiskSettingsStore } from './security/risk-settings.store.js';
import { TokenRiskService } from './security/token-risk.service.js';
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
  const heartbeat = new HeartbeatService(
    checkpoints,
    sessions,
    {
      getHttpLatestBlock: () => publicClient.getBlockNumber(),
      getWsLatestBlock: () => wsClient.getBlockNumber(),
    },
    config.executionMode,
  );
  const metadataService = new TokenMetadataService(publicClient);
  const risk = new TokenRiskService(publicClient, riskSettings);
  const executor = new TradeExecutor(trades);
  const engine = new SessionEngine(sessions, reports, risk, executor);
  const monitors = new Map<string, SwapListener>();
  const activeSessionsByToken = new Map<string, TokenSession>();
  const activeTokenByPair = new Map<string, string>();

  const removeMonitor = (pair: Address): void => {
    const pairKey = pair.toLowerCase();
    const tokenKey = activeTokenByPair.get(pairKey);
    monitors.delete(pairKey);
    activeTokenByPair.delete(pairKey);
    if (tokenKey) activeSessionsByToken.delete(tokenKey);
  };

  const stopMonitor = (pair: Address): void => {
    const key = pair.toLowerCase();
    monitors.get(key)?.stop();
    removeMonitor(pair);
  };

  const dashboardActions = new DashboardActionService(
    ignoredAssets,
    engine,
    (token) => activeSessionsByToken.get(token.toLowerCase()) ?? null,
    stopMonitor,
  );
  const dashboard = config.dashboardEnabled
    ? new ActionDashboardServer(
      new DashboardService(new DashboardRepository(), heartbeat),
      riskSettings,
      dashboardActions,
    )
    : null;

  const startMonitor = async (session: TokenSession): Promise<void> => {
    const key = session.pair.pair.toLowerCase();
    const tokenKey = session.pair.token.toLowerCase();
    if (monitors.has(key)) return;
    if (monitors.size >= config.maxActivePairMonitors) {
      logger.warn(
        { pair: session.pair.pair, max: config.maxActivePairMonitors },
        'Moniteur ignoré: capacité maximale atteinte.',
      );
      return;
    }
    const listener = new SwapListener(
      session,
      checkpoints,
      events,
      engine,
      removeMonitor,
    );
    monitors.set(key, listener);
    activeSessionsByToken.set(tokenKey, session);
    activeTokenByPair.set(key, tokenKey);
    try {
      await listener.start();
    } catch (error) {
      removeMonitor(session.pair.pair);
      throw error;
    }
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
    await startMonitor(session);
  };

  const restored = await sessions.loadActive();
  for (const session of restored) {
    if (await ignoredAssets.isIgnored(session.pair.token)) {
      await engine.ignoreManually(session);
      continue;
    }
    await startMonitor(session);
  }

  const pairListener = new PairCreatedListener(checkpoints, onPair);
  await pairListener.start();

  const refreshHeartbeat = async (): Promise<void> => {
    const snapshot = await heartbeat.refresh(monitors.size);
    logger.info(
      {
        latestBlock: snapshot.latestBlock,
        pairCreatedCheckpoint: snapshot.pairCreatedCheckpoint,
        activeSwapMonitors: snapshot.activeSwapMonitors,
        activeSessions: snapshot.activeSessions,
        executionMode: snapshot.executionMode,
        httpStatus: snapshot.http.status,
        wsStatus: snapshot.webSocket.status,
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
    logger.info({ signal }, 'Arrêt du bot.');
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
