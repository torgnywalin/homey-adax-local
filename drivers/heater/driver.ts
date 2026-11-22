import { createHash } from 'node:crypto';
import net from 'node:net';
import Homey from 'homey';
import {
  BleProvisioner,
  FoundHeater,
  HeaterNotFoundError,
  InvalidWifiError,
  WriteWithoutResponseOnlyError,
} from '../../lib/adax/BleProvisioner';
import { AdaxHttpError, LocalClient } from '../../lib/adax/LocalClient';
import type AdaxHeaterDevice = require('./device');

type PairSession = Parameters<Homey.Driver['onPair']>[0];

interface PendingDevice {
  name: string;
  id: string;
  ip: string;
  token: string;
  mac: string;
  deviceType: number | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class AdaxHeaterDriver extends Homey.Driver {
  async onInit() {
    this.log('Adax heater driver initialized');
  }

  async onPair(session: PairSession) {
    const provisioner = new BleProvisioner(this.homey.ble, this.log.bind(this));
    let pending: PendingDevice | null = null;

    this.registerCommonHandlers(session, provisioner);

    session.setHandler('provision', async (data: { peripheralUuid: string; ssid: string; password: string }) => {
      const result = await this.provision(session, provisioner, data);
      const mac = result.heater.adax.wifiMac;
      pending = {
        name: `Adax ${mac.slice(-8).replace(/:/g, '').toUpperCase()}`,
        id: mac,
        ip: result.ip,
        token: result.token,
        mac,
        deviceType: result.heater.adax.type,
      };
      return { ip: result.ip, name: pending.name };
    });

    session.setHandler('manual', async (data: { ip: string; token: string }) => {
      const ip = String(data.ip ?? '').trim();
      const token = String(data.token ?? '').trim();
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('errors.invalid_ip'));
      if (!token) throw new Error(this.homey.__('errors.missing_token'));
      await this.verifyConnection(ip, token, 1);
      const mac = await this.homey.arp.getMAC(ip).then((m) => m.toLowerCase()).catch(() => '');
      const id = mac || `manual-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
      pending = { name: `Adax ${ip}`, id, ip, token, mac, deviceType: null };
      return { ip, name: pending.name };
    });

    session.setHandler('list_devices', async () => {
      if (!pending) return [];
      return [{
        name: pending.name,
        data: { id: pending.id },
        store: { ip: pending.ip, token: pending.token, deviceType: pending.deviceType },
        settings: { ip: pending.ip, mac: pending.mac || '-' },
      }];
    });
  }

  async onRepair(session: PairSession, device?: Homey.Device) {
    const heater = device as AdaxHeaterDevice | undefined;
    if (!heater) throw new Error('No device to repair');
    const provisioner = new BleProvisioner(this.homey.ble, this.log.bind(this));

    this.registerCommonHandlers(session, provisioner);

    session.setHandler('provision', async (data: { peripheralUuid: string; ssid: string; password: string }) => {
      const result = await this.provision(session, provisioner, data);
      await heater.applyConnection(result.ip, result.token);
      return { ip: result.ip, name: heater.getName(), repaired: true };
    });

    session.setHandler('rediscover', async () => {
      const ip = await heater.rediscover();
      if (!ip) throw new Error(this.homey.__('errors.not_found_on_network'));
      return { ip };
    });
  }

  private registerCommonHandlers(session: PairSession, provisioner: BleProvisioner) {
    session.setHandler('scan', async () => {
      const heaters = await provisioner.scan();
      return heaters.map((h: FoundHeater) => ({
        peripheralUuid: h.peripheralUuid,
        mac: h.adax.wifiMac,
        type: h.adax.type,
        status: h.adax.status,
        rssi: h.rssi,
        available: h.available,
        knownType: h.knownType,
      }));
    });
  }

  /** BLE provisioning + verification that the heater answers on WiFi. */
  private async provision(
    session: PairSession,
    provisioner: BleProvisioner,
    data: { peripheralUuid: string; ssid: string; password: string },
  ) {
    const ssid = String(data.ssid ?? '');
    const password = String(data.password ?? '');
    if (!ssid) throw new Error(this.homey.__('errors.missing_ssid'));

    const emitProgress = (step: string) => session.emit('progress', this.homey.__(`pair.progress.${step}`)).catch(this.error);

    let result;
    try {
      result = await provisioner.provision(data.peripheralUuid, ssid, password, { onProgress: emitProgress });
    } catch (err) {
      throw this.translateError(err);
    }

    emitProgress('verifying');
    await this.verifyConnection(result.ip, result.token, 12);
    return result;
  }

  /** Poll `stat` until the heater answers; it can take a while after joining WiFi. */
  private async verifyConnection(ip: string, token: string, attempts: number): Promise<void> {
    const client = new LocalClient({ ip, token, retries: 0, timeoutMs: 8000 });
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const status = await client.getStatus();
        this.log(`Heater ${ip} answered`, status.raw);
        return;
      } catch (err) {
        lastError = err;
        this.log(`Waiting for heater at ${ip} (${attempt}/${attempts}): ${(err as Error).message}`);
        if (attempt < attempts) await sleep(5000);
      }
    }
    throw this.translateError(lastError, ip);
  }

  private translateError(err: unknown, ip?: string): Error {
    if (err instanceof InvalidWifiError) return new Error(this.homey.__('errors.invalid_wifi'));
    if (err instanceof WriteWithoutResponseOnlyError) return new Error(this.homey.__('errors.write_without_response'));
    if (err instanceof HeaterNotFoundError) return new Error(this.homey.__('errors.heater_not_found'));
    if (err instanceof AdaxHttpError) {
      if (err.statusCode === 401 || err.statusCode === 403) return new Error(this.homey.__('errors.unauthorized'));
      return new Error(this.homey.__('errors.http', { status: err.statusCode }));
    }
    if (ip) return new Error(this.homey.__('errors.no_answer', { ip, message: (err as Error)?.message ?? String(err) }));
    return err instanceof Error ? err : new Error(String(err));
  }
}

export = AdaxHeaterDriver;
