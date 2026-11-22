import { BLE_COMMAND_STATUS_INVALID_WIFI, BLE_COMMAND_STATUS_OK } from './constants';

export type JoinNotification =
  | { kind: 'joined'; ip: string }
  | { kind: 'invalid_wifi' }
  /** Status OK but no IP yet, or an unknown status code – keep waiting. */
  | { kind: 'other'; status: number | null };

/**
 * Parse a notification received on the command characteristic after `join`.
 *   [0, a, b, c, d] -> joined WiFi with IPv4 a.b.c.d
 *   [1]             -> invalid WiFi credentials
 */
export function parseJoinNotification(data: Buffer | Uint8Array): JoinNotification {
  const bytes = Buffer.from(data);
  if (bytes.length === 0) return { kind: 'other', status: null };
  const status = bytes[0];
  if (status === BLE_COMMAND_STATUS_INVALID_WIFI) return { kind: 'invalid_wifi' };
  if (status === BLE_COMMAND_STATUS_OK && bytes.length >= 5) {
    const ip = `${bytes[1]}.${bytes[2]}.${bytes[3]}.${bytes[4]}`;
    if (ip !== '0.0.0.0') return { kind: 'joined', ip };
  }
  return { kind: 'other', status };
}
