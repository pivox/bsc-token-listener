function redactUrl(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s'"<>]+/giu, '[REDACTED_RPC_URL]')
    .replace(/wss?:\/\/[^\s'"<>]+/giu, '[REDACTED_RPC_URL]')
    .replace(
      /(?:^|[\s"'])(x-api-key|xapikey|apikey|api[-_]?key|access[_-]?token|authorization|bearer)\s*[:=]\s*[^\s"']+/giu,
      '$1=[REDACTED]',
    );
}

function redactPrivateKeys(raw: string): string {
  return raw
    .replace(
      /\b(?:private[-_]?key|private key|secret[-_]?key|secret key|wif|mnemonic)\s*[:=]\s*(0x)?[a-fA-F0-9]{64}\b/giu,
      'private_key=[REDACTED_PRIVATE_KEY]',
    )
      .replace(/\bseed[_-]?phrase\s*[:=]\s*[^\s"']+/giu, 'seed_phrase=[REDACTED_SEED]');
}

export function sanitizeRpcText(input: string): string {
  const maskedUrls = redactUrl(input);
  return redactPrivateKeys(maskedUrls)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b/g, '[REDACTED_HOST]')
    .replace(/localhost:\d{1,5}/giu, 'localhost:[REDACTED_HOST_PORT]')
    .replace(/127\.0\.0\.1:\d{1,5}/giu, '127.0.0.1:[REDACTED_HOST_PORT]');
}

export function sanitizeRpcError(input: string): string {
  return sanitizeRpcText(input);
}
