import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, isAddress, parseEther, type Address, type Hex } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';
export type ExecutionMode = 'dry-run' | 'live';
export type StorageDriver = 'memory' | 'postgres';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  network: NetworkName;
  httpUrls: readonly string[];
  wssUrls: readonly string[];
  txHttpUrl: string | undefined;
  executionMode: ExecutionMode;
  privateKey: Hex | undefined;
  simulationAccount: Address | undefined;
  buyAmountWei: bigint;
  targetBuysAfterEntry: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  txDeadlineSeconds: number;
  minWbnbLiquidityWei: bigint;
  maxConcurrentPositions: number;
  pairWaitFirstBuySeconds: number;
  maxActivePairMonitors: number;
  eventBackfillBlocks: number;
  eventBackfillChunkSize: number;
  eventReconcileSeconds: number;
  requireSafetyProbe: boolean;
  safetyProbeAddress: Address | undefined;
  maxRoundTripLossBps: number;
  enableDirectDeploymentListener: boolean;
  storageDriver: StorageDriver;
  databaseUrl: string;
  postgresAutoMigrate: boolean;
  logLevel: LogLevel;
}

function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) {
    return;
  }

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function env(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined || value.trim() === '') {
    throw new Error(`Variable d'environnement obligatoire manquante: ${name}`);
  }

  return value.trim();
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseRpcUrl(name: string, value: string, protocols: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} contient une URL invalide.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} doit utiliser ${protocols.join(' ou ')}.`);
  }
  return value;
}

function parseList(
  name: string,
  protocols: readonly string[],
): readonly string[] {
  const values = env(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseRpcUrl(name, value, protocols));

  if (values.length === 0) {
    throw new Error(`${name} doit contenir au moins une URL.`);
  }

  return values;
}

function parseBoolean(name: string, defaultValue: boolean): boolean {
  const value = optionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} doit valoir true ou false.`);
}

function parseInteger(name: string, defaultValue: number, min: number, max: number): number {
  const raw = optionalEnv(name) ?? String(defaultValue);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

function parseAddress(name: string): Address | undefined {
  const value = optionalEnv(name);
  if (value === undefined) {
    return undefined;
  }
  if (!isAddress(value)) {
    throw new Error(`${name} n'est pas une adresse EVM valide.`);
  }
  return getAddress(value);
}

function parsePrivateKey(): Hex | undefined {
  const value = optionalEnv('PRIVATE_KEY');
  if (value === undefined) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error('PRIVATE_KEY doit être une clé hexadécimale de 32 octets préfixée par 0x.');
  }
  return value as Hex;
}

function parseNetwork(): NetworkName {
  const value = env('BSC_NETWORK', 'mainnet');
  if (value !== 'mainnet' && value !== 'testnet') {
    throw new Error('BSC_NETWORK doit valoir mainnet ou testnet.');
  }
  return value;
}

function parseExecutionMode(): ExecutionMode {
  const value = env('EXECUTION_MODE', 'dry-run');
  if (value !== 'dry-run' && value !== 'live') {
    throw new Error('EXECUTION_MODE doit valoir dry-run ou live.');
  }
  return value;
}

function parseStorageDriver(): StorageDriver {
  const value = env('STORAGE_DRIVER', 'memory');
  if (value !== 'memory' && value !== 'postgres') {
    throw new Error('STORAGE_DRIVER doit valoir memory ou postgres.');
  }
  return value;
}

function parseLogLevel(): LogLevel {
  const value = env('LOG_LEVEL', 'info');
  if (value !== 'debug' && value !== 'info' && value !== 'warn' && value !== 'error') {
    throw new Error('LOG_LEVEL doit valoir debug, info, warn ou error.');
  }
  return value;
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const executionMode = parseExecutionMode();
  const privateKey = parsePrivateKey();
  const requireSafetyProbe = parseBoolean('REQUIRE_SAFETY_PROBE', true);
  const safetyProbeAddress = parseAddress('SAFETY_PROBE_ADDRESS');

  if (executionMode === 'live' && privateKey === undefined) {
    throw new Error('PRIVATE_KEY est obligatoire en mode live.');
  }
  if (executionMode === 'live' && requireSafetyProbe && safetyProbeAddress === undefined) {
    throw new Error('SAFETY_PROBE_ADDRESS est obligatoire en mode live lorsque REQUIRE_SAFETY_PROBE=true.');
  }

  const buyAmountRaw = env('BUY_AMOUNT_BNB', '0.01');
  const minLiquidityRaw = env('MIN_WBNB_LIQUIDITY', '1');
  let buyAmountWei: bigint;
  let minWbnbLiquidityWei: bigint;
  try {
    buyAmountWei = parseEther(buyAmountRaw);
    minWbnbLiquidityWei = parseEther(minLiquidityRaw);
  } catch (error) {
    throw new Error(`Montant BNB invalide: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (buyAmountWei <= 0n) {
    throw new Error('BUY_AMOUNT_BNB doit être strictement positif.');
  }
  if (minWbnbLiquidityWei < 0n) {
    throw new Error('MIN_WBNB_LIQUIDITY ne peut pas être négatif.');
  }

  const rawTxHttpUrl = optionalEnv('BSC_TX_HTTP_URL');
  const txHttpUrl =
    rawTxHttpUrl === undefined
      ? undefined
      : parseRpcUrl('BSC_TX_HTTP_URL', rawTxHttpUrl, ['http:', 'https:']);
  const simulationAccount = parseAddress('SIMULATION_ACCOUNT');

  return {
    network: parseNetwork(),
    httpUrls: parseList('BSC_HTTP_URLS', ['http:', 'https:']),
    wssUrls: parseList('BSC_WSS_URLS', ['ws:', 'wss:']),
    txHttpUrl,
    executionMode,
    privateKey,
    simulationAccount,
    buyAmountWei,
    targetBuysAfterEntry: parseInteger('TARGET_BUYS_AFTER_ENTRY', 10, 1, 10_000),
    buySlippageBps: parseInteger('BUY_SLIPPAGE_BPS', 2500, 0, 9999),
    sellSlippageBps: parseInteger('SELL_SLIPPAGE_BPS', 3500, 0, 9999),
    txDeadlineSeconds: parseInteger('TX_DEADLINE_SECONDS', 90, 10, 3600),
    minWbnbLiquidityWei,
    maxConcurrentPositions: parseInteger('MAX_CONCURRENT_POSITIONS', 1, 1, 1000),
    pairWaitFirstBuySeconds: parseInteger('PAIR_WAIT_FIRST_BUY_SECONDS', 300, 10, 86_400),
    maxActivePairMonitors: parseInteger('MAX_ACTIVE_PAIR_MONITORS', 50, 1, 10_000),
    eventBackfillBlocks: parseInteger('EVENT_BACKFILL_BLOCKS', 200, 0, 100_000),
    eventBackfillChunkSize: parseInteger('EVENT_BACKFILL_CHUNK_SIZE', 50, 1, 10_000),
    eventReconcileSeconds: parseInteger('EVENT_RECONCILE_SECONDS', 15, 5, 3600),
    requireSafetyProbe,
    safetyProbeAddress,
    maxRoundTripLossBps: parseInteger('MAX_ROUND_TRIP_LOSS_BPS', 3500, 0, 9999),
    enableDirectDeploymentListener: parseBoolean('ENABLE_DIRECT_DEPLOYMENT_LISTENER', false),
    storageDriver: parseStorageDriver(),
    databaseUrl: env('DATABASE_URL', 'postgresql://bscbot:bscbot@127.0.0.1:5439/bscbot'),
    postgresAutoMigrate: parseBoolean('POSTGRES_AUTO_MIGRATE', true),
    logLevel: parseLogLevel(),
  };
}
