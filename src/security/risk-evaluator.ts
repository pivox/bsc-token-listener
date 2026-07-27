import type { RiskCheck, RiskVerdict } from './token-risk.types.js';

export interface RiskEvaluation {
  score: number;
  verdict: RiskVerdict;
}

export interface RiskEvaluationSettings {
  allowUnknownReviews: boolean;
  allowUnknownMinScore: number;
}

const STRICT_SETTINGS: RiskEvaluationSettings = {
  allowUnknownReviews: false,
  allowUnknownMinScore: 100,
};

export function evaluateRisk(
  checks: RiskCheck[],
  minimumScore: number,
  settings: RiskEvaluationSettings = STRICT_SETTINGS,
): RiskEvaluation {
  const score = Math.max(
    0,
    Math.min(100, 100 - checks.reduce((sum, check) => sum + check.penalty, 0)),
  );

  const criticalFailure = checks.some(
    (check) => check.critical && check.status === 'FAIL',
  );
  if (criticalFailure || score < 40) return { score, verdict: 'BLOCK' };

  const warning = checks.some((check) => check.status === 'WARN');
  if (warning) return { score, verdict: 'REVIEW' };

  const unknown = checks.some((check) => check.status === 'UNKNOWN');
  if (unknown && (!settings.allowUnknownReviews || score < settings.allowUnknownMinScore)) {
    return { score, verdict: 'REVIEW' };
  }

  if (score < minimumScore) return { score, verdict: 'REVIEW' };
  return { score, verdict: 'ALLOW' };
}
