import 'dotenv/config';
import {
  getAddress,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { readBlockConfirmations } from '../chain/confirmed-blocks.js';
import { parsePositionExitSettings } from '../strategy/position-exit-settings.js';
import type { ExecutionMode } from '../types/domain.js';

function read(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined && fallback.length > 0) return fallback;
  throw new Error(`Variable d'environnement obligatoire manquante: ${name}`);
}

function splitUrls(name: string): string[] {
  return process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];
}

function firstUrl(name?: string, legacyName?: string): string | undefined {
  if (!name) return undefined;
  return [...splitUrls(name), ...(legacyName ? splitUrls(legacyName) : [])][0];
}

function parseProviderUrls(
  name: string,
  legacyName?: string,
  secondaryLegacyName?: string,
): string[] {
  const urls = new Set<string>();
  for (const url of [
    ...splitUrls(name),
    ...(legacyName ? splitUrls(legacyName) : []),
    ...(secondaryLegacyName ? splitUrls(secondaryLegacyName) : []),
  ]) {
    if (url.length > 0) urls.add(url);
  }
  return [...urls];
}

function readWithFallback(
  name: string,
  legacyName?: string,
  secondaryLegacyName?: string,
): string | undefined {
  return firstUrl(name, legacyName) ?? firstUrl(legacyName, secondaryLegacyName);
}

function readBoolean(name: string, fallback: boolean, legacyName?: string): boolean {
  const raw = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  const value = raw?.toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} doit être un booléen.`);
}

function readInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
  legacyName?: string,
): number {
  const raw = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

export function parseRpcMaxLogBlockRange(value: string | undefined): number {
  const parsed = Number(value ?? '100');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1500) {
    throw new Error('RPC_MAX_LOG_BLOCK_RANGE doit être un entier entre 1 et 1500.');
  }
  return parsed;
}

function readAddress(name: string, fallback?: string): Address {
  const value = read(name, fallback);
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${name} n'est pas une adresse EVM valide.`);
  }
  return getAddress(value.toLowerCase());
}

function readOptionalAddress(name: string, legacyName?: string): Address | undefined {
  const value = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  if (!value) return undefined;
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${name} n'est pas une adresse EVM valide.`);
  }
  return getAddress(value.toLowerCase());
}

function readPrivateKey(): Hex | undefined {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) return undefined;
  const value = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error('PRIVATE_KEY doit contenir exactement 32 octets hexadécimaux.');
  }
  return value as Hex;
}

const network = read('BSC_NETWORK', 'mainnet');
if (network !== 'mainnet' && network !== 'testnet') {
  throw new Error('BSC_NETWORK doit valoir mainnet ou testnet.');
}

const executionMode = read('EXECUTION_MODE', 'dry-run') as ExecutionMode;
if (executionMode !== 'dry-run' && executionMode !== 'live') {
  throw new Error('EXECUTION_MODE doit valoir dry-run ou live.');
}

const riskPolicy = read('RISK_POLICY', 'allow-only');
if (riskPolicy !== 'allow-only' && riskPolicy !== 'block-only') {
  throw new Error('RISK_POLICY doit valoir allow-only ou block-only.');
}

const privateKey = readPrivateKey();
const safetyProbeAddress = readOptionalAddress('SAFETY_PROBE_ADDRESS');
const riskProbeCaller = readOptionalAddress('RISK_PROBE_CALLER', 'SIMULATION_ACCOUNT');

if (executionMode === 'live') {
  if (!privateKey) throw new Error('PRIVATE_KEY est obligatoire en mode live.');
  if (read('CONFIRM_LIVE_TRADING', '') !== 'I_UNDERSTAND_REAL_FUNDS') {
    throw new Error('Mode live bloqué: définir CONFIRM_LIVE_TRADING=I_UNDERSTAND_REAL_FUNDS.');
  }
  if (riskPolicy !== 'allow-only') {
    throw new Error('Le mode live exige RISK_POLICY=allow-only.');
  }
  if (!safetyProbeAddress) {
    throw new Error('Le mode live exige SAFETY_PROBE_ADDRESS.');
  }
}

const minBuyBnbWei = parseEther(read('MIN_BUY_BNB', '0.002'));
const maxBuyBnbWei = parseEther(read('MAX_BUY_BNB', '0.005'));
const buyAmountStepWei = parseEther(read('BUY_AMOUNT_STEP_BNB', '0.0001'));

if (maxBuyBnbWei < minBuyBnbWei) {
  throw new Error('MAX_BUY_BNB doit être supérieur ou égal à MIN_BUY_BNB.');
}

if (buyAmountStepWei <= 0n) {
  throw new Error('BUY_AMOUNT_STEP_BNB doit être strictement positif.');
}

if (buyAmountStepWei > minBuyBnbWei) {
  throw new Error('BUY_AMOUNT_STEP_BNB doit être inférieur ou égal à MIN_BUY_BNB.');
}

const targetBuysAfterEntry = readInteger('TARGET_BUYS_AFTER_ENTRY', 3, 1, 1_000);
const positionExitSettings = parsePositionExitSettings({
  monitorIntervalSeconds: readInteger('EXIT_MONITOR_INTERVAL_SECONDS', 15, 5, 300),
  maxHoldingMinutes: readInteger('EXIT_MAX_HOLDING_MINUTES', 30, 1, 10_080),
  stopLossBps: readInteger('EXIT_STOP_LOSS_BPS', 1_000, 1, 10_000),
  takeProfitBps: readInteger('EXIT_TAKE_PROFIT_BPS', 2_000, 1, 100_000),
  liquidityDropBps: readInteger('EXIT_LIQUIDITY_DROP_BPS', 2_000, 1, 10_000),
  probeIntervalSeconds: readInteger('EXIT_SAFETY_PROBE_INTERVAL_SECONDS', 60, 15, 3_600),
  quoteBufferBps: readInteger('EXIT_QUOTE_BUFFER_BPS', 1_500, 0, 5_000),
  maxGasValueBps: readInteger('EXIT_MAX_GAS_VALUE_BPS', 1_000, 1, 10_000),
  emergencyMaxGasWei: parseEther(read('EXIT_EMERGENCY_MAX_GAS_BNB', '0.01')),
  approvalGasUnits: BigInt(
    readInteger('EXIT_APPROVAL_GAS_UNITS', 80_000, 21_000, 1_000_000),
  ),
  sellGasUnits: BigInt(
    readInteger('EXIT_SELL_GAS_UNITS', 350_000, 21_000, 2_000_000),
  ),
  trailingEnabled: readBoolean('EXIT_TRAILING_STOP_ENABLED', false),
  trailingActivationBps: readInteger('EXIT_TRAILING_ACTIVATION_BPS', 2_000, 1, 100_000),
  trailingDrawdownBps: readInteger('EXIT_TRAILING_DRAWDOWN_BPS', 500, 1, 10_000),
  targetBuysAfterEntry,
});

const httpRpcUrls = parseProviderUrls(
  'BSC_HTTP_RPC_URLS',
  'BSC_HTTP_URLS',
  'BSC_HTTP_RPC_URL',
);
const wsRpcUrls = parseProviderUrls(
  'BSC_WS_RPC_URLS',
  'BSC_WSS_URLS',
  'BSC_WS_RPC_URL',
);
if (httpRpcUrls.length === 0) {
  throw new Error('Aucun endpoint BSC_HTTP_RPC_URL / BSC_HTTP_RPC_URLS disponible.');
}
const httpRpcUrl = httpRpcUrls[0];
if (!httpRpcUrl) throw new Error('Aucun endpoint BSC_HTTP_RPC_URL disponible.');
const wsRpcUrl = wsRpcUrls[0] ?? httpRpcUrl;
const txRpcUrl = readWithFallback(
  'BSC_TX_RPC_URL',
  'BSC_TX_URL',
) ?? httpRpcUrl;

export const config = {
  network,
  blockConfirmations: readBlockConfirmations(process.env),
  httpRpcUrls,
  wsRpcUrls,
  httpRpcUrl,
  wsRpcUrl,
  txRpcUrl,
  databaseUrl: read('DATABASE_URL'),
  autoMigrate: readBoolean('POSTGRES_AUTO_MIGRATE', true),
  dashboardEnabled: readBoolean('DASHBOARD_ENABLED', true),
  dashboardHost: read('DASHBOARD_HOST', '127.0.0.1'),
  dashboardPort: readInteger('DASHBOARD_PORT', 3000, 1, 65_535),
  dashboardRefreshSeconds: readInteger('DASHBOARD_REFRESH_SECONDS', 5, 2, 300),
  dashboardMaxRows: readInteger('DASHBOARD_MAX_ROWS', 250, 25, 5_000),
  factory: readAddress(
    'PANCAKE_FACTORY_ADDRESS',
    network === 'mainnet' ? '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' : undefined,
  ),
  router: readAddress(
    'PANCAKE_ROUTER_ADDRESS',
    network === 'mainnet' ? '0x10ED43C718714eb63d5aA57B78B54704E256024E' : undefined,
  ),
  wbnb: readAddress(
    'WBNB_ADDRESS',
    network === 'mainnet' ? '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' : undefined,
  ),
  executionMode,
  privateKey,
  buyAmountWei: parseEther(read('BUY_AMOUNT_BNB', '0.01')),
  minBuyBnbWei,
  maxBuyBnbWei,
  buyAmountStepWei,
  buyLiquidityShareBps: readInteger('BUY_LIQUIDITY_SHARE_BPS', 50, 1, 10000),
  buyMedianFactorBps: readInteger('BUY_MEDIAN_FACTOR_BPS', 5000, 1, 10000),
  buyWalletShareBps: readInteger('BUY_WALLET_SHARE_BPS', 1000, 1, 10000),
  gasReserveWei: parseEther(read('GAS_RESERVE_BNB', '0.005')),
  slippageBps: readInteger('SLIPPAGE_BPS', 1500, 0, 5000, 'BUY_SLIPPAGE_BPS'),
  txDeadlineSeconds: readInteger('TX_DEADLINE_SECONDS', 90, 15, 600),
  targetBuysAfterEntry,
  positionExitSettings,
  entryObservationBuys: readInteger('ENTRY_OBSERVATION_BUYS', 3, 1, 20),
  maxConcurrentPositions: readInteger('MAX_CONCURRENT_POSITIONS', 1, 1, 100),
  maxActivePairMonitors: readInteger('MAX_ACTIVE_PAIR_MONITORS', 50, 1, 1000),
  pairMonitorTtlMinutes: readInteger('PAIR_MONITOR_TTL_MINUTES', 90, 1, 1440),
  reconcileSeconds: readInteger('RECONCILE_SECONDS', 15, 5, 300, 'EVENT_RECONCILE_SECONDS'),
  recoveryIntervalSeconds: readInteger('RECOVERY_INTERVAL_SECONDS', 30, 5, 300),
  recoveryLeaseSeconds: readInteger('RECOVERY_LEASE_SECONDS', 60, 15, 600),
  recoveryStaleSeconds: readInteger('RECOVERY_STALE_SECONDS', 180, 30, 3600),
  riskPolicy,
  riskMinScore: readInteger('RISK_MIN_SCORE', 80, 0, 100),
  riskAllowUnknownReviews: readBoolean('RISK_ALLOW_UNKNOWN_REVIEWS', false),
  riskAllowUnknownMinScore: readInteger('RISK_ALLOW_UNKNOWN_MIN_SCORE', 95, 0, 100),
  minWbnbLiquidityWei: parseEther(read('MIN_WBNB_LIQUIDITY', '0.25')),
  riskProbeRequired: readBoolean('RISK_PROBE_REQUIRED', true, 'REQUIRE_SAFETY_PROBE'),
  safetyProbeAddress,
  riskProbeCaller,
  riskProbeAmountWei: parseEther(read('RISK_PROBE_AMOUNT_BNB', '0.005')),
  riskMaxBuyTaxBps: readInteger('RISK_MAX_BUY_TAX_BPS', 1500, 0, 10000),
  riskMaxSellTaxBps: readInteger('RISK_MAX_SELL_TAX_BPS', 1500, 0, 10000),
  rpcMaxLogBlockRange: parseRpcMaxLogBlockRange(process.env.RPC_MAX_LOG_BLOCK_RANGE),
  swapReconcileCoalesceWindowMs: readInteger(
    'SWAP_RECONCILE_COALESCE_WINDOW_MS',
    250,
    10,
    5_000,
    'SWAP_SIGNAL_COALESCE_WINDOW_MS',
  ),
  swapLogBatchMaxAddresses: readInteger(
    'SWAP_LOG_BATCH_MAX_ADDRESSES',
    20,
    1,
    200,
  ),
  rpcMaxHttpRps: readInteger('RPC_MAX_HTTP_RPS', 20, 1, 25),
  rpcMaxHttpRetries: readInteger('RPC_MAX_HTTP_RETRIES', 3, 1, 10),
  rpcMonthlyRequestBudget: readInteger(
    'RPC_MONTHLY_REQUEST_BUDGET',
    3_000_000,
    1,
    100_000_000,
  ),
  riskMaxRoundTripLossBps: readInteger(
    'RISK_MAX_ROUNDTRIP_LOSS_BPS',
    3000,
    0,
    10000,
    'MAX_ROUND_TRIP_LOSS_BPS',
  ),
} as const;
