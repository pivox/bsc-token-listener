import { maxUint256, type Address, type Hash } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import type { AppConfig } from '../config/env.js';
import type { RpcClients } from '../rpc/clients.js';
import { NonceManager } from '../rpc/nonce-manager.js';
import { Logger } from '../utils/logger.js';
import { BroadcastedTransactionError } from './errors.js';

export class ApproveExecutor {
  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly nonceManager: NonceManager | undefined,
    private readonly logger: Logger,
  ) {}

  public async ensureAllowance(
    token: Address,
    spender: Address,
    requiredAmount: bigint,
  ): Promise<Hash[]> {
    if (this.config.executionMode === 'dry-run') {
      return [];
    }

    const traderAddress = this.clients.traderAddress;
    if (
      this.clients.account === undefined ||
      this.clients.walletClient === undefined ||
      traderAddress === undefined ||
      this.nonceManager === undefined
    ) {
      throw new Error("Client de signature absent pour l'approbation.");
    }

    if ((await this.readAllowance(token, traderAddress, spender)) >= requiredAmount) {
      return [];
    }

    const hashes: Hash[] = [];
    try {
      hashes.push(await this.sendApproval(token, spender, maxUint256));
      await this.assertAllowance(token, traderAddress, spender, requiredAmount);
      return hashes;
    } catch (firstError) {
      if (
        firstError instanceof BroadcastedTransactionError &&
        firstError.outcome !== 'REVERTED'
      ) {
        throw firstError;
      }
      this.logger.warn("L'approbation directe a échoué; tentative approve(0) puis approve(max).", {
        token,
        firstError,
      });
    }

    hashes.push(await this.sendApproval(token, spender, 0n));
    hashes.push(await this.sendApproval(token, spender, maxUint256));
    await this.assertAllowance(token, traderAddress, spender, requiredAmount);
    return hashes;
  }

  private async assertAllowance(
    token: Address,
    owner: Address,
    spender: Address,
    requiredAmount: bigint,
  ): Promise<void> {
    const allowance = await this.readAllowance(token, owner, spender);
    if (allowance < requiredAmount) {
      throw new Error(
        `Allowance insuffisante après approbation: ${allowance} < ${requiredAmount}.`,
      );
    }
  }

  private async readAllowance(
    token: Address,
    owner: Address,
    spender: Address,
  ): Promise<bigint> {
    return (await this.clients.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    })) as bigint;
  }

  private async sendApproval(token: Address, spender: Address, amount: bigint): Promise<Hash> {
    const account = this.clients.account;
    const walletClient = this.clients.walletClient;
    const nonceManager = this.nonceManager;
    if (account === undefined || walletClient === undefined || nonceManager === undefined) {
      throw new Error("Client de signature absent pour l'approbation.");
    }

    const { request } = await this.clients.publicClient.simulateContract({
      account,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    });

    const hash = await nonceManager.send<Hash>((nonce) =>
      walletClient.writeContract({ ...request, nonce }),
    );
    this.logger.info('Transaction approve diffusée.', { token, spender, amount, transactionHash: hash });

    let receipt;
    try {
      receipt = await this.clients.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120_000,
      });
    } catch (error) {
      throw new BroadcastedTransactionError(
        `Approve diffusé (${hash}) mais reçu non confirmé dans le délai.`,
        hash,
        'UNKNOWN',
        error,
      );
    }
    if (receipt.status !== 'success') {
      throw new BroadcastedTransactionError(`Transaction approve révoquée: ${hash}`, hash, 'REVERTED');
    }
    return hash;
  }
}
