import type { TokenSession } from '../types/domain.js';
import { hasUnreconciledConfirmedSell } from '../strategy/execution-failure-policy.js';

export function canManuallySell(session: TokenSession | null): boolean {
  if (!session?.entry || session.exit) return false;
  if (hasUnreconciledConfirmedSell(session)) return false;
  return session.status === 'HOLDING' || session.status === 'MANUAL_REVIEW';
}

export function canIgnoreAsset(session: TokenSession | null): boolean {
  if (!session) return true;
  if (session.entry && !session.exit) return false;
  return ['WAITING_FIRST_BUY', 'REJECTED', 'EXPIRED'].includes(session.status);
}
