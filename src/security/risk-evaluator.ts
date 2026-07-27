import type { RiskCheck, RiskVerdict } from './token-risk.types.js';

export interface RiskEvaluation {
  score: number;
  verdict: RiskVerdict;
}

export function evaluateRisk(checks: RiskCheck[], minimumScore: number): RiskEvaluation {
  const score = Math.max(
    0,
    Math.min(100, 100 - checks.reduce((sum, check) => sum + check.penalty, 0)),
  );

  const criticalFailure = checks.some(
    (check) => check.critical && check.status === 'FAIL',
  );
  if (criticalFailure || score < 40) return { score, verdict: 'BLOCK' };

  const uncertain = checks.some(
    (check) => check.status === 'WARN' || check.status === 'UNKNOWN',
  );
  if (uncertain || score < minimumScore) return { score, verdict: 'REVIEW' };

  return { score, verdict: 'ALLOW' };
}
