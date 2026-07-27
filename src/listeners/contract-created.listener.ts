import type { Address, Hash, Transaction } from 'viem';
import type { RpcClients } from '../rpc/clients.js';
import { TokenChecker } from '../security/token-checker.js';
import type { BotStore } from '../storage/store.js';
import { Logger } from '../utils/logger.js';
import { SerialTaskQueue } from '../utils/serial-task-queue.js';

interface BlockLike {
  number: bigint | null;
  transactions: readonly (Hash | Transaction)[];
}

export class ContractCreatedListener {
  private unwatch: (() => void) | undefined;
  private readonly queue = new SerialTaskQueue();
  private readonly tokenChecker: TokenChecker;

  public constructor(
    private readonly clients: RpcClients,
    private readonly store: BotStore,
    private readonly logger: Logger,
  ) {
    this.tokenChecker = new TokenChecker(clients.publicClient);
  }

  public start(): void {
    if (this.unwatch !== undefined) {
      return;
    }

    this.unwatch = this.clients.subscriptionClient.watchBlocks({
      includeTransactions: true,
      emitMissed: true,
      onBlock: (block) => {
        void this.queue.run(() => this.processBlock(block as BlockLike)).catch((error: unknown) => {
          this.logger.error('Échec du traitement d’un bloc de déploiements directs.', { error });
        });
      },
      onError: (error) => {
        this.logger.error("Erreur de l'écoute des déploiements directs.", { error });
      },
    });
    this.logger.info('Écoute optionnelle des déploiements directs active.');
  }

  public stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private async processBlock(block: BlockLike): Promise<void> {
    if (block.number === null) {
      return;
    }

    for (const value of block.transactions) {
      if (typeof value === 'string' || value.to !== null) {
        continue;
      }

      try {
        const receipt = await this.clients.publicClient.getTransactionReceipt({ hash: value.hash });
        if (receipt.status !== 'success' || receipt.contractAddress === null) {
          continue;
        }

        const address = receipt.contractAddress as Address;
        const check = await this.tokenChecker.inspect(address);
        await this.store.saveDiscoveredToken({
          address,
          deploymentTransactionHash: value.hash,
          deploymentBlock: block.number,
          deployer: value.from,
          metadata: check.metadata,
          isProbableBep20: check.accepted,
          rejectionReason: check.reason,
          discoveredAtMs: Date.now(),
        });

        if (check.accepted) {
          this.logger.info('Contrat BEP-20 probable déployé directement.', {
            address,
            deployer: value.from,
            transactionHash: value.hash,
            symbol: check.metadata?.symbol,
          });
        }
      } catch (error) {
        this.logger.debug("Le contrat déployé n'est pas un BEP-20 lisible.", {
          transactionHash: value.hash,
          error,
        });
      }
    }
  }
}
