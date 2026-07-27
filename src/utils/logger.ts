import pino from 'pino';

export const logger = pino({
  base: { service: 'bsc-token-listener-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['privateKey', '*.privateKey', 'BSC_HTTP_RPC_URL', 'BSC_WS_RPC_URL'],
    censor: '[REDACTED]',
  },
});
