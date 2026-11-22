/**
 * Constants for the Adax local protocol.
 *
 * Source: pyAdaxLocal (adax_local/__init__.py) and Adax' "Local API User Guide"
 * (https://adax.no/wi-fi/api-development/).
 */

/** BLE service advertised by Adax heaters that can be provisioned. */
export const ADAX_BLE_SERVICE_UUID = '3885cc10-7c18-4ad4-a48d-bf11abf7cb92';

/** Single characteristic used for both writing commands and receiving notifications. */
export const ADAX_BLE_COMMAND_UUID = '0000cc11-0000-1000-8000-00805f9b34fb';

/**
 * Device types (first manufacturer-data byte) that support BLE provisioning.
 * 5  = Gen 2 heater (officially documented)
 * 8  = Gen 2 "WiFi Heater VG11" (tested with this app, fw 2.0.2.27)
 * 9  = some newer panel heaters (works per pyAdaxLocal PR #23, not merged)
 * 11 = Gen 3 "WT3" thermostat (Adax)
 * 17 = Gen 3 "WT3" thermostat (Glamox)
 */
export const ADAX_BLE_DEVICE_TYPES: ReadonlySet<number> = new Set([5, 8, 9, 11, 17]);

/** Max payload bytes per BLE write (2 header bytes + 17 = 19 bytes per write). */
export const MAX_BYTES_IN_COMMAND_CHUNK = 17;

/** Status byte values in the join notification. */
export const BLE_COMMAND_STATUS_OK = 0;
export const BLE_COMMAND_STATUS_INVALID_WIFI = 1;

/** Subject CN of the heater's self-signed TLS certificate. */
export const ADAX_CERT_CN = 'ADAX DEVICE';

/** HTTPS port of the local API. */
export const ADAX_LOCAL_PORT = 443;
