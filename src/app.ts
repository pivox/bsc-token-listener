import { formatEther, getAddress, isAddressEqual } from 'viem';
import { pancakeRouterAbi } from './abi/pancake-router.abi.js';
import { BscTokenListenerBot } from './bot.js';
import { loadConfig } from './config/env.js';
import { getPancakeV2Contracts } from './config/network.js';
import { assertExpectedChain, createRpcClients } from './rpc/clients.js';
import { RpcHealthMonitor } from './rpc/health-monitor.js';
import { createStore } from './storage/create-store.js';
import { Logger, redactSensitiveText } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, { service: 'bsc-token-listener-bot' });
  const contracts = getPancakeV2Contracts(config.network);
  const clients = createRpcClients(config);
  await assertExpectedChain(clients);

  const [routerFactory, routerWbnb] = await Promise.all([
    clients.publicClient.readContract({
      address: contracts.router,
      abi: pancakeRouterAbi,
      functionName: 'factory',
    }),
    clients.publicClient.readContract({
      address: contracts.router,
      abi: pancakeRouterAbi,
      functionName: 'WETH',
    }),
  ]);
  if (!isAddressEqual(routerFactory, contracts.factory)) {
    throw new Error(
      `Le routeur ${contracts.router} annonce la factory ${routerFactory}, pas ${contracts.factory}.`,
    );
  }
  const wbnb = getAddress(routerWbnb);

  if (config.executionMode === 'live' && clients.traderAddress !== undefined) {
    const balance = await clients.publicClient.getBalance({ address: clients.traderAddress });
    if (balance <= config.buyAmountWei) {
      throw new Error(
        `Solde trader insuffisant: ${formatEther(balance)} BNB pour un achat de ${formatEther(config.buyAmountWei)} BNB, hors gas.`,
      );
    }
    logger.warn('MODE LIVE ACTIVÉ: des transactions réelles pourront être signées.', {
      traderAddress: clients.traderAddress,
      balanceBnb: formatEther(balance),
      buyAmountBnb: formatEther(config.buyAmountWei),
    });
  } else {
    logger.info('Mode dry-run: aucune transaction ne sera envoyée.');
  }

  const store = createStore(config);
  await store.initialize();
  const bot = new BscTokenListenerBot(
    config,
    clients,
    contracts,
    wbnb,
    store,
    logger,
  );
  const httpHealthMonitor = new RpcHealthMonitor(clients.publicClient, logger, 'http');
  const websocketHealthMonitor = new RpcHealthMonitor(
    clients.subscriptionClient,
    logger,
    'websocket',
  );
  httpHealthMonitor.start();
  websocketHealthMonitor.start();
  await bot.start();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('Arrêt demandé.', { signal });
    httpHealthMonitor.stop();
    websocketHealthMonitor.stop();
    await bot.stop();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'Arrêt fatal du bot.',
      error: error instanceof Error
        ? {
            message: redactSensitiveText(error.message),
            stack: error.stack === undefined ? undefined : redactSensitiveText(error.stack),
          }
        : redactSensitiveText(String(error)),
    }),
  );
  process.exitCode = 1;
});
