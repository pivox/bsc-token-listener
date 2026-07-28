import {
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import { pancakeRouterAbi } from '../abi/pancake-router.abi.js';
import { account, publicClient, walletClient } from '../rpc/clients.js';
import type {
  ExecutionGateway,
  ExecutionReceipt,
  PreparedExecutionTransaction,
} from './execution.types.js';

export function preparedTransactionFromSigned(input: {
  step: 'BUY' | 'APPROVE' | 'SELL';
  nonce: bigint;
  walletAddress: Address;
  toAddress: Address;
  valueWei: bigint;
  serializedTransaction: Hex;
}): PreparedExecutionTransaction {
  return {
    ...input,
    hash: keccak256(input.serializedTransaction),
  };
}

export class ViemExecutionGateway implements ExecutionGateway {
  readonly walletAddress = account?.address ?? null;

  async quote(input: {
    router: Address;
    path: readonly [Address, Address];
    amountIn: bigint;
  }): Promise<bigint> {
    const amounts = await publicClient.readContract({
      address: input.router,
      abi: pancakeRouterAbi,
      functionName: 'getAmountsOut',
      args: [input.amountIn, [...input.path]],
    });
    return amounts[amounts.length - 1] ?? 0n;
  }

  async getTokenBalance(token: Address, wallet: Address): Promise<bigint> {
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
    });
  }

  async getNativeBalance(wallet: Address): Promise<bigint> {
    return publicClient.getBalance({ address: wallet });
  }

  async getAllowance(input: {
    token: Address;
    owner: Address;
    spender: Address;
  }): Promise<bigint> {
    return publicClient.readContract({
      address: input.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.spender],
    });
  }

  async prepareBuy(input: {
    router: Address;
    path: readonly [Address, Address];
    amountInWei: bigint;
    minimumOut: bigint;
    deadline: bigint;
  }): Promise<PreparedExecutionTransaction> {
    return this.prepare({
      step: 'BUY',
      toAddress: input.router,
      valueWei: input.amountInWei,
      data: encodeFunctionData({
        abi: pancakeRouterAbi,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [
          input.minimumOut,
          [...input.path],
          this.requireWallet(),
          input.deadline,
        ],
      }),
    });
  }

  async prepareApproval(input: {
    token: Address;
    spender: Address;
    amount: bigint;
  }): Promise<PreparedExecutionTransaction> {
    return this.prepare({
      step: 'APPROVE',
      toAddress: input.token,
      valueWei: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [input.spender, input.amount],
      }),
    });
  }

  async prepareSell(input: {
    router: Address;
    path: readonly [Address, Address];
    amountInToken: bigint;
    minimumOut: bigint;
    deadline: bigint;
  }): Promise<PreparedExecutionTransaction> {
    return this.prepare({
      step: 'SELL',
      toAddress: input.router,
      valueWei: 0n,
      data: encodeFunctionData({
        abi: pancakeRouterAbi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [
          input.amountInToken,
          input.minimumOut,
          [...input.path],
          this.requireWallet(),
          input.deadline,
        ],
      }),
    });
  }

  async sendRawTransaction(serializedTransaction: Hex) {
    return publicClient.sendRawTransaction({ serializedTransaction });
  }

  async waitForReceipt(hash: `0x${string}`): Promise<ExecutionReceipt> {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 120_000,
    });
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.transactionIndex,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
    };
  }

  private requireWallet(): Address {
    if (!this.walletAddress || !walletClient || !account) {
      throw new Error('Wallet live non initialisé.');
    }
    return this.walletAddress;
  }

  private async prepare(input: {
    step: 'BUY' | 'APPROVE' | 'SELL';
    toAddress: Address;
    valueWei: bigint;
    data: Hex;
  }): Promise<PreparedExecutionTransaction> {
    if (!walletClient || !account) {
      throw new Error('Wallet live non initialisé.');
    }
    const request = await walletClient.prepareTransactionRequest({
      account,
      to: input.toAddress,
      data: input.data,
      value: input.valueWei,
    });
    const serializedTransaction = await account.signTransaction(
      request as Parameters<typeof account.signTransaction>[0],
    );
    if (request.nonce === undefined) {
      throw new Error('Nonce absent de la transaction préparée.');
    }
    return preparedTransactionFromSigned({
      step: input.step,
      nonce: BigInt(request.nonce),
      walletAddress: account.address,
      toAddress: input.toAddress,
      valueWei: input.valueWei,
      serializedTransaction,
    });
  }
}
