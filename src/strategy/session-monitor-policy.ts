import type { TokenSession } from '../types/domain.js';

export function isSessionMonitorable(session: TokenSession): boolean {
  return session.status === 'WAITING_FIRST_BUY' || session.status === 'HOLDING';
}
