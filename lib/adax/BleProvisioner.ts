import type Homey from 'homey';
import { parseAdvertisement, isAvailableForProvisioning, isKnownType, AdaxAdvertisement } from './advertisement';
import { buildJoinCommand, chunkCommand, generateToken } from './command';
import { ADAX_BLE_COMMAND_UUID, ADAX_BLE_SERVICE_UUID } from './constants';
import { parseJoinNotification } from './notification';
import { normalizeUuid, uuidEquals } from './uuid';

type ManagerBLE = Homey.Homey['ble'];
type BleAdvertisement = Homey.BleAdvertisement;
type BlePeripheral = Homey.BlePeripheral;
type BleCharacteristic = Homey.BleCharacteristic;

export interface FoundHeater {
  /** Homey peripheral UUID, used to connect. */
  peripheralUuid: string;
  bleAddress: string;
  rssi: number;
  adax: AdaxAdvertisement;
  available: boolean;
  knownType: boolean;
}

export interface ProvisionResult {
  ip: string;
  token: string;
  heater: FoundHeater;
}

export class InvalidWifiError extends Error {
  constructor() {
    super('The heater could not join the WiFi network (wrong SSID/password, or not a 2.4 GHz network)');
    this.name = 'InvalidWifiError';
  }
}

export class WriteWithoutResponseOnlyError extends Error {
  constructor(properties: string[]) {
    super(`The Adax command characteristic only supports write-without-response (${properties.join(', ')}), which Homey does not support`);
    this.name = 'WriteWithoutResponseOnlyError';
  }
}

export class HeaterNotFoundError extends Error {
  constructor() {
    super('Heater not found over Bluetooth. Make sure it is in pairing mode (blue LED blinking) and close to Homey.');
    this.name = 'HeaterNotFoundError';
  }
}

type Log = (...args: unknown[]) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ProvisionOptions {
  /** How long to wait for the IP notification after the last write. Default 60 s. */
  notificationTimeoutMs?: number;
  /** Connect attempts. Default 3. */
  connectAttempts?: number;
  onProgress?: (step: 'connecting' | 'sending' | 'waiting') => void;
}

/**
 * Provisions an Adax heater over BLE: sends WiFi credentials and a freshly
 * generated local API token, and waits for the heater to report its IP.
 */
export class BleProvisioner {
  private readonly advertisements = new Map<string, BleAdvertisement>();

  constructor(private readonly ble: ManagerBLE, private readonly log: Log) {}

  /** Scan for Adax heaters. Includes heaters that are not in pairing mode (available=false). */
  async scan(): Promise<FoundHeater[]> {
    const all = await this.ble.discover();
    const serviceUuid = normalizeUuid(ADAX_BLE_SERVICE_UUID);
    const heaters: FoundHeater[] = [];

    for (const adv of all) {
      const services = (adv.serviceUuids ?? []).map(normalizeUuid);
      if (!services.includes(serviceUuid)) continue;

      // Diagnostics for the hardware spike: log exactly what Homey reports.
      this.log('Adax advertisement', {
        uuid: adv.uuid,
        address: adv.address,
        localName: adv.localName,
        serviceUuids: adv.serviceUuids,
        manufacturerData: adv.manufacturerData?.toString('hex'),
        rssi: adv.rssi,
      });

      const adax = parseAdvertisement(adv.manufacturerData);
      if (!adax) {
        this.log(`Ignoring ${adv.uuid}: manufacturer data too short`);
        continue;
      }
      this.advertisements.set(adv.uuid, adv);
      heaters.push({
        peripheralUuid: adv.uuid,
        bleAddress: adv.address,
        rssi: adv.rssi,
        adax,
        available: isAvailableForProvisioning(adax),
        knownType: isKnownType(adax),
      });
    }
    this.log(`BLE scan: ${all.length} advertisements, ${heaters.length} Adax heater(s)`);
    return heaters.sort((a, b) => b.rssi - a.rssi);
  }

  async provision(peripheralUuid: string, ssid: string, psk: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
    const notificationTimeoutMs = options.notificationTimeoutMs ?? 60000;
    const connectAttempts = options.connectAttempts ?? 3;
    const progress = options.onProgress ?? (() => undefined);

    let advertisement = this.advertisements.get(peripheralUuid);
    if (!advertisement) {
      advertisement = await this.ble.find(peripheralUuid).catch(() => undefined);
    }
    if (!advertisement) throw new HeaterNotFoundError();
    const adax = parseAdvertisement(advertisement.manufacturerData);
    if (!adax) throw new HeaterNotFoundError();
    const heater: FoundHeater = {
      peripheralUuid,
      bleAddress: advertisement.address,
      rssi: advertisement.rssi,
      adax,
      available: isAvailableForProvisioning(adax),
      knownType: isKnownType(adax),
    };

    const token = generateToken();
    const chunks = chunkCommand(buildJoinCommand(ssid, psk, token));

    progress('connecting');
    const peripheral = await this.connect(advertisement, connectAttempts);
    let characteristic: BleCharacteristic | undefined;
    try {
      characteristic = await this.findCommandCharacteristic(peripheral);

      let settle: { resolve: (ip: string) => void; reject: (err: Error) => void } | undefined;
      const result = new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
      });
      // Subscribe BEFORE writing so the response is not missed.
      await characteristic.subscribeToNotifications((data: Buffer) => {
        this.log(`BLE notification: ${data.toString('hex')}`);
        const parsed = parseJoinNotification(data);
        if (parsed.kind === 'joined') settle?.resolve(parsed.ip);
        else if (parsed.kind === 'invalid_wifi') settle?.reject(new InvalidWifiError());
      });

      progress('sending');
      this.log(`Sending join command in ${chunks.length} chunk(s)`);
      for (const chunk of chunks) {
        await characteristic.write(chunk);
      }

      progress('waiting');
      const ip = await withTimeout(result, notificationTimeoutMs,
        'Timed out waiting for the heater to report its IP address. Check that the WiFi is 2.4 GHz and in range.');
      this.log(`Heater joined WiFi with IP ${ip}`);
      return { ip, token, heater };
    } finally {
      if (characteristic) await characteristic.unsubscribeFromNotifications().catch((err: Error) => this.log('unsubscribe failed', err.message));
      await peripheral.disconnect().catch((err: Error) => this.log('disconnect failed', err.message));
    }
  }

  private async connect(advertisement: BleAdvertisement, attempts: number): Promise<BlePeripheral> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await advertisement.connect();
      } catch (err) {
        lastError = err;
        this.log(`BLE connect attempt ${attempt}/${attempts} failed: ${(err as Error).message}`);
        if (attempt < attempts) await sleep(2000 * attempt);
      }
    }
    throw lastError;
  }

  private async findCommandCharacteristic(peripheral: BlePeripheral): Promise<BleCharacteristic> {
    const services = await peripheral.discoverAllServicesAndCharacteristics();
    let found: BleCharacteristic | undefined;
    for (const service of services) {
      for (const characteristic of service.characteristics ?? []) {
        this.log(`GATT ${service.uuid} / ${characteristic.uuid} [${(characteristic.properties ?? []).join(', ')}]`);
        if (uuidEquals(characteristic.uuid, ADAX_BLE_COMMAND_UUID)) {
          // Prefer the one in the Adax service if it appears more than once.
          if (!found || uuidEquals(service.uuid, ADAX_BLE_SERVICE_UUID)) found = characteristic;
        }
      }
    }
    if (!found) throw new Error('Adax command characteristic (cc11) not found on the heater');

    const properties = (found.properties ?? []).map((p) => p.toLowerCase());
    if (!properties.includes('write') && properties.some((p) => p.includes('withoutresponse'))) {
      throw new WriteWithoutResponseOnlyError(found.properties);
    }
    return found;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
