const BLE_BASE_SUFFIX = '00001000800000805f9b34fb';

/**
 * Normalize a BLE UUID to 128-bit, lowercase, no dashes, so UUIDs can be
 * compared regardless of the format Homey reports them in.
 * Accepts 16-bit ('cc11'), 32-bit ('0000cc11') and 128-bit (with/without dashes).
 */
export function normalizeUuid(uuid: string): string {
  const clean = uuid.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (clean.length === 4) return `0000${clean}${BLE_BASE_SUFFIX}`;
  if (clean.length === 8) return `${clean}${BLE_BASE_SUFFIX}`;
  return clean;
}

export function uuidEquals(a: string, b: string): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}
