import { keccak256, toBytes, type Hex } from 'viem';

export interface SensitiveSelectorMatch {
  signature: string;
  category: 'MINT' | 'BLACKLIST' | 'TAX' | 'LIMIT' | 'TRADING' | 'PAUSE' | 'UPGRADE';
  selector: Hex;
}

const SIGNATURES: Array<Omit<SensitiveSelectorMatch, 'selector'>> = [
  { signature: 'mint(address,uint256)', category: 'MINT' },
  { signature: 'mint(uint256)', category: 'MINT' },
  { signature: 'setBlacklist(address,bool)', category: 'BLACKLIST' },
  { signature: 'blacklist(address,bool)', category: 'BLACKLIST' },
  { signature: 'setBot(address,bool)', category: 'BLACKLIST' },
  { signature: 'setBots(address[],bool)', category: 'BLACKLIST' },
  { signature: 'setBuyTax(uint256)', category: 'TAX' },
  { signature: 'setSellTax(uint256)', category: 'TAX' },
  { signature: 'setFees(uint256,uint256)', category: 'TAX' },
  { signature: 'setTaxFeePercent(uint256)', category: 'TAX' },
  { signature: 'setMaxTxAmount(uint256)', category: 'LIMIT' },
  { signature: 'setMaxWalletSize(uint256)', category: 'LIMIT' },
  { signature: 'setMaxWalletAmount(uint256)', category: 'LIMIT' },
  { signature: 'enableTrading()', category: 'TRADING' },
  { signature: 'openTrading()', category: 'TRADING' },
  { signature: 'setTradingEnabled(bool)', category: 'TRADING' },
  { signature: 'pause()', category: 'PAUSE' },
  { signature: 'unpause()', category: 'PAUSE' },
  { signature: 'upgradeTo(address)', category: 'UPGRADE' },
  { signature: 'upgradeToAndCall(address,bytes)', category: 'UPGRADE' },
];

export function functionSelector(signature: string): Hex {
  return `0x${keccak256(toBytes(signature)).slice(2, 10)}` as Hex;
}

export function scanSensitiveSelectors(bytecode: Hex): SensitiveSelectorMatch[] {
  const normalized = bytecode.toLowerCase();
  return SIGNATURES.flatMap((item) => {
    const selector = functionSelector(item.signature);
    return normalized.includes(selector.slice(2).toLowerCase())
      ? [{ ...item, selector }]
      : [];
  });
}
