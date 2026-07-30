import { sanitizeRpcText } from './sanitize.js';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeRpcText(error.message);
  }
  return sanitizeRpcText(String(error));
}
