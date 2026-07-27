import type { AppPublicClient } from './clients.js';
import { Logger } from '../utils/logger.js';

export class RpcHealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  private lastBlock: bigint | undefined;
  private stagnantChecks = 0;

  public constructor(
    private readonly publicClient: AppPublicClient,
    private readonly logger: Logger,
    private readonly transportName: 'http' | 'websocket',
    private readonly intervalMs = 15_000,
  ) {}

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref();
    void this.check();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    try {
      const block = await this.publicClient.getBlockNumber();
      if (block === this.lastBlock) {
        this.stagnantChecks += 1;
      } else {
        this.stagnantChecks = 0;
        this.lastBlock = block;
      }

      if (this.stagnantChecks >= 3) {
        this.logger.warn('Le RPC ne progresse plus depuis plusieurs contrôles.', {
          transport: this.transportName,
          block,
          stagnantChecks: this.stagnantChecks,
        });
      } else {
        this.logger.debug('RPC opérationnel.', { transport: this.transportName, block });
      }
    } catch (error) {
      this.logger.error('Échec du contrôle de santé RPC.', {
        transport: this.transportName,
        error,
      });
    }
  }
}
