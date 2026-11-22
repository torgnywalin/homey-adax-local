import { randomBytes } from 'node:crypto';
import { MAX_BYTES_IN_COMMAND_CHUNK } from './constants';

/**
 * Percent-encode exactly like Python's `urllib.parse.quote(s)` (safe='/').
 * encodeURIComponent leaves !'()* unencoded and encodes '/', Python does the opposite.
 */
export function pyQuote(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, '/');
}

/** Generate a new local API token (20 lowercase hex chars, like `secrets.token_hex(10)`). */
export function generateToken(): string {
  return randomBytes(10).toString('hex');
}

/** Build the BLE join command: `command=join&ssid=..&psk=..&token=..` as ASCII bytes. */
export function buildJoinCommand(ssid: string, psk: string, token: string): Buffer {
  const command = `command=join&ssid=${pyQuote(ssid)}&psk=${pyQuote(psk)}&token=${pyQuote(token)}`;
  return Buffer.from(command, 'ascii');
}

/**
 * Split a command into BLE writes: [chunkIndex, isLast, ...up to 17 payload bytes].
 */
export function chunkCommand(command: Buffer): Buffer[] {
  const chunkCount = Math.ceil(command.length / MAX_BYTES_IN_COMMAND_CHUNK);
  if (chunkCount > 256) throw new Error('Command too long for BLE chunking');
  const chunks: Buffer[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1;
    const payload = command.subarray(i * MAX_BYTES_IN_COMMAND_CHUNK, (i + 1) * MAX_BYTES_IN_COMMAND_CHUNK);
    chunks.push(Buffer.concat([Buffer.from([i, isLast ? 1 : 0]), payload]));
  }
  return chunks;
}

/**
 * WPA/WPA2 passphrases are 8–63 characters, or a 64-character hex PSK.
 * An empty password is allowed for open networks.
 */
export function isValidWifiPassword(password: string): boolean {
  if (password.length === 0) return true;
  if (password.length >= 8 && password.length <= 63) return true;
  return /^[0-9a-f]{64}$/i.test(password);
}
