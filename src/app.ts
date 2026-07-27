import type { Address } from 'viem';
import { pancakeRouterAbi } from './abi/pancake-router.abi.js';
import { chain } from './config/chain.js';
import { config } from './config/env.js';
import {
  DashboardRepository,
  DashboardServer,
  DashboardService,
} from './dashboard/dashboard.js';
import { TokenMetadataService } from './discovery/token-metadata.service.js';
import { TradeExecutor } from './execution/trade-executor.js';
import { PairCreatedListener } from './listeners/pair-created.listener.js';
import { SwapListener } from './listeners/swap.listener.js';
import { publicClient } from './rpc/clients.js';
import { TokenRiskService } from './security/token-risk.service.js';
import { closeDatabase, migrate } from './storage/database.js';
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
  const metadataService = new TokenMetadataService(publicClient);
  const risk = new TokenRiskService(publicClient);
  const executor = new TradeExecutor(trades);
  const engine = new SessionEngine(sessions, reports, risk, executor);
  const monitors = new Map<string, SwapListener>();
  const dashboard = config.dashboardEnabled
    ? new DashboardServer(new DashboardService(new DashboardRepository()))
    : null;

  const removeMonitor = (pair: Address): void => {
    monitors.delete(pair.toLowerCase());
  };

  const startMonitor = async (session: TokenSession): Promise<void> => {
    const key = session.pair.pair.toLowerCase();
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
    try {
      await listener.start();
    } catch (error) {
      monitors.delete(key);
      throw error;
    }
  };

  const onPair = async (pair: PairInfo): Promise<void> => {
    const key = pair.pair.toLowerCase();
    if (monitors.has(key)) return;

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
    await startMonitor(session);
  }

  const pairListener = new PairCreatedListener(checkpoints, onPair);
  await pairListener.start();

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

  logger.info(
    {
      network: config.network,
      executionMode: config.executionMode,
      riskPolicy: config.riskPolicy,
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
