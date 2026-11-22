import { ADAX_BLE_DEVICE_TYPES } from './constants';

export interface AdaxAdvertisement {
  /** Device type, see ADAX_BLE_DEVICE_TYPES. */
  type: number;
  /** Raw status byte. */
  status: number;
  /** Bit 0: heater is registered (in the Adax cloud). */
  registered: boolean;
  /** Bit 1: heater is managed. */
  managed: boolean;
  /** 8-byte big-endian ID as a decimal string (same value Home Assistant uses as unique id). */
  deviceId: string;
  /** Last 6 bytes of the ID, which is the heater's WiFi MAC, e.g. "74:4d:bd:4f:38:44". */
  wifiMac: string;
}

/**
 * Parse Adax manufacturer data.
 *
 * Expects the RAW manufacturer-data bytes as broadcast (including the two
 * bytes that BLE normally treats as company id – Adax does not use a real
 * company id):
 *   [0]     device type
 *   [1]     status (bit0 = registered, bit1 = managed)
 *   [2..9]  8-byte device id (observed as 00 01 + WiFi MAC)
 *
 * Returns null if the buffer is too short to be Adax data.
 */
export function parseAdvertisement(data: Buffer | Uint8Array | null | undefined): AdaxAdvertisement | null {
  if (!data || data.length < 10) return null;
  const bytes = Buffer.from(data);
  const type = bytes[0];
  const status = bytes[1];
  const idBytes = bytes.subarray(2, 10);
  const deviceId = BigInt(`0x${idBytes.toString('hex')}`).toString(10);
  const wifiMac = Array.from(idBytes.subarray(2, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
  return {
    type,
    status,
    registered: (status & 0x01) !== 0,
    managed: (status & 0x02) !== 0,
    deviceId,
    wifiMac,
  };
}

/**
 * Like pyAdaxLocal `device_available` (non-zero id, not registered, not managed),
 * but does NOT require a known device type: the advertised Adax service UUID
 * already identifies the heater, and new types appear (type 8 observed on a
 * Gen 2 heater, 2026-11). Use `isKnownType` to warn about untested types.
 */
export function isAvailableForProvisioning(adv: AdaxAdvertisement): boolean {
  return adv.deviceId !== '0' && !adv.registered && !adv.managed;
}

/** Device types confirmed to work by pyAdaxLocal / Home Assistant users. */
export function isKnownType(adv: AdaxAdvertisement): boolean {
  return ADAX_BLE_DEVICE_TYPES.has(adv.type);
}
