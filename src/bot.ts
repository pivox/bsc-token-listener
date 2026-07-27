import type { Address } from 'viem';
import type { AppConfig } from './config/env.js';
import type { PancakeV2Contracts } from './config/network.js';
import { PairResolver, type PairCreatedDetection } from './discovery/pair-resolver.js';
import { ApproveExecutor } from './execution/approve.executor.js';
import { BuyExecutor } from './execution/buy.executor.js';
import { SellExecutor } from './execution/sell.executor.js';
import { ContractCreatedListener } from './listeners/contract-created.listener.js';
import { PairCreatedListener } from './listeners/pair-created.listener.js';
import { PairMonitor } from './listeners/pair-monitor.js';
import type { RpcClients } from './rpc/clients.js';
import { NonceManager } from './rpc/nonce-manager.js';
import { SecurityService } from './security/security-service.js';
import type { BotStore } from './storage/store.js';
import { StrategyEngine } from './strategy/strategy-engine.js';
import { TokenSession } from './strategy/token-session.js';
import { Logger } from './utils/logger.js';

export class BscTokenListenerBot {
  private readonly sessions = new Map<string, TokenSession>();
  private readonly monitors = new Map<string, PairMonitor>();
  private readonly monitorStartTasks = new Set<Promise<void>>();
  private readonly pairResolver: PairResolver;
  private readonly strategy: StrategyEngine;
  private readonly pairCreatedListener: PairCreatedListener;
  private readonly contractCreatedListener: ContractCreatedListener | undefined;
  private expirationTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly contracts: PancakeV2Contracts,
    private readonly wbnb: Address,
    private readonly store: BotStore,
    private readonly logger: Logger,
  ) {
    const nonceManager =
      clients.walletClient !== undefined && clients.traderAddress !== undefined
        ? new NonceManager(clients.publicClient, clients.traderAddress)
        : undefined;
    const approveExecutor = new ApproveExecutor(config, clients, nonceManager, logger);
    const buyExecutor = new BuyExecutor(config, clients, nonceManager);
    const sellExecutor = new SellExecutor(
      config,
      clients,
      nonceManager,
      approveExecutor,
    );
    const securityService = new SecurityService(
      clients.publicClient,
      config,
      clients.traderAddress,
    );

    this.strategy = new StrategyEngine(
      config,
      securityService,
      buyExecutor,
      sellExecutor,
      store,
      logger,
      () => this.countOpenPositions(),
    );
    this.pairResolver = new PairResolver(clients.publicClient, contracts, wbnb);
    this.pairCreatedListener = new PairCreatedListener(
      config,
      clients,
      contracts,
      logger,
      (detection) => this.registerPair(detection),
    );
    this.contractCreatedListener = config.enableDirectDeploymentListener
      ? new ContractCreatedListener(clients, store, logger)
      : undefined;
  }

  public async start(): Promise<void> {
    await this.restoreSessions();
    await this.pairCreatedListener.start();
    this.contractCreatedListener?.start();

    this.expirationTimer = setInterval(() => {
      void this.expireWaitingSessions();
    }, 10_000);
    this.expirationTimer.unref();

    this.logger.info('Bot démarré.', {
      network: this.config.network,
      executionMode: this.config.executionMode,
      factory: this.contracts.factory,
      router: this.contracts.router,
      wbnb: this.wbnb,
      activePairMonitors: this.monitors.size,
      targetBuysAfterEntry: this.config.targetBuysAfterEntry,
    });
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.pairCreatedListener.stop();
    this.contractCreatedListener?.stop();
    if (this.expirationTimer !== undefined) {
      clearInterval(this.expirationTimer);
      this.expirationTimer = undefined;
    }
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();
    await Promise.allSettled([...this.monitorStartTasks]);
    await this.store.close();
    this.logger.info('Bot arrêté proprement.');
  }

  private async restoreSessions(): Promise<void> {
    const snapshots = await this.store.listOpenSessions();
    for (const snapshot of snapshots) {
      const session = TokenSession.restore(snapshot);

      if (session.status === 'SELL_PENDING') {
        session.markSellFailed('Processus interrompu pendant une vente; reprise du suivi en HOLDING.');
        await this.store.saveSession(session.snapshot);
      } else if (session.status === 'WAITING_FIRST_BUY') {
        session.expire(
          "Redémarrage avant l'entrée: session expirée pour éviter un achat tardif sur un premier Swap historique.",
        );
        await this.store.saveSession(session.snapshot);
        continue;
      } else if (session.status === 'CHECKING' || session.status === 'BUY_PENDING') {
        session.markError(
          "Processus interrompu pendant l'entrée; vérifier manuellement le wallet avant toute reprise.",
        );
        await this.store.saveSession(session.snapshot);
        continue;
      }

      if (session.status !== 'HOLDING') {
        continue;
      }

      this.sessions.set(this.key(session.pair.pair), session);
      await this.startMonitor(session);
    }

    if (snapshots.length > 0) {
      this.logger.info('Sessions persistées restaurées.', {
        found: snapshots.length,
        resumed: this.sessions.size,
      });
    }
  }

  private async registerPair(detection: PairCreatedDetection): Promise<void> {
    if (this.stopped) {
      return;
    }

    const pair = await this.pairResolver.resolve(detection);
    if (pair === undefined) {
      return;
    }

    const key = this.key(pair.pair);
    if (this.sessions.has(key)) {
      return;
    }
    const existing = await this.store.getSession(pair.pair);
    if (existing !== undefined) {
      return;
    }

    const session = TokenSession.create(pair, this.config.targetBuysAfterEntry);
    if (this.monitors.size >= this.config.maxActivePairMonitors) {
      session.reject('Limite de moniteurs de paires atteinte.');
      await this.store.saveSession(session.snapshot);
      this.logger.warn('Nouvelle paire ignorée: limite de moniteurs atteinte.', {
        pair: pair.pair,
        token: pair.token,
      });
      return;
    }

    await this.store.saveSession(session.snapshot);
    this.sessions.set(key, session);
    this.launchMonitor(session);
    this.logger.info('Nouvelle paire Token/WBNB enregistrée.', {
      pair: pair.pair,
      token: pair.token,
      blockNumber: pair.createdBlock,
      transactionHash: pair.createdTransactionHash,
    });
  }

  private launchMonitor(session: TokenSession): void {
    const task = this.startMonitor(session)
      .catch((error: unknown) => {
        this.logger.error("Échec inattendu du démarrage d'un moniteur.", {
          pair: session.pair.pair,
          token: session.pair.token,
          error,
        });
      })
      .finally(() => {
        this.monitorStartTasks.delete(task);
      });
    this.monitorStartTasks.add(task);
  }

  private async startMonitor(session: TokenSession): Promise<void> {
    if (this.stopped) {
      return;
    }

    const key = this.key(session.pair.pair);
    if (this.monitors.has(key)) {
      return;
    }

    const monitor = new PairMonitor(
      this.config,
      this.clients,
      this.store,
      session,
      this.logger.child({ pair: session.pair.pair, token: session.pair.token }),
      (event) => this.strategy.handleSwap(session, event),
      () => this.removeTerminalSession(session),
    );
    this.monitors.set(key, monitor);
    try {
      await monitor.start();
    } catch (error) {
      monitor.stop();
      this.monitors.delete(key);
      this.sessions.delete(key);
      session.markError(error);
      try {
        await this.store.saveSession(session.snapshot);
      } catch (persistenceError) {
        this.logger.error("Impossible de persister l'échec de démarrage du moniteur.", {
          pair: session.pair.pair,
          persistenceError,
        });
      }
      this.logger.error("Impossible de démarrer l'écoute de la paire.", {
        pair: session.pair.pair,
        error,
      });
    }
  }

  private removeTerminalSession(session: TokenSession): void {
    const key = this.key(session.pair.pair);
    this.monitors.get(key)?.stop();
    this.monitors.delete(key);
    this.sessions.delete(key);
  }

  private async expireWaitingSessions(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        const expired = await this.strategy.expireIfNeeded(session, Date.now());
        if (expired) {
          this.removeTerminalSession(session);
          this.logger.info("Session expirée faute de premier achat.", {
            pair: session.pair.pair,
            token: session.pair.token,
          });
        }
      } catch (error) {
        this.logger.error("Échec du contrôle d'expiration d'une session.", {
          pair: session.pair.pair,
          error,
        });
      }
    }
  }

  private countOpenPositions(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.isHolding) {
        count += 1;
      }
    }
    return count;
  }

  private key(address: Address): string {
    return address.toLowerCase();
  }
}
