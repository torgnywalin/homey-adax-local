import net from 'node:net';
import Homey from 'homey';
import { AdaxHttpError, AdaxStatus, isAuthError, LocalClient } from '../../lib/adax/LocalClient';
import { HeaterController, HeaterHost, LocalChange, StoreKey } from '../../lib/adax/HeaterController';
import { clampTarget, estimatePowerW, LocalChangeMode, parseLocalChangeMode } from '../../lib/adax/policy';
import type AdaxHeaterDriver = require('./driver');

/** Consecutive poll failures before the device is marked unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Minimum time between automatic network scans for a lost heater. */
const REDISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
/** Homey gives up on a capability change after 10 s; answer well before that. */
const UI_WRITE_DEADLINE_MS = 8500;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

class AdaxHeaterDevice extends Homey.Device {
  private client!: LocalClient;
  private controller!: HeaterController;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastRediscovery = 0;
  private rediscovering: Promise<string | null> | null = null;
  private disposed = false;

  async onInit() {
    const { ip, token } = this.getStore() as { ip: string; token: string };
    this.client = new LocalClient({ ip, token });
    this.controller = new HeaterController(this.client, this.createHost());

    // Migrations: power is estimated from rated power (Homey Energy computes kWh),
    // the heater's own energy counter is not used.
    if (!this.hasCapability('measure_power')) await this.addCapability('measure_power').catch(this.error);
    if (this.hasCapability('meter_power')) await this.removeCapability('meter_power').catch(this.error);

    this.registerMultipleCapabilityListener(
      ['onoff', 'target_temperature'],
      (values) => this.onCapabilities(values as { onoff?: boolean; target_temperature?: number }),
      500,
    );

    this.startPolling();
    this.poll();
    this.readDeviceInfo().catch(this.error);
    this.log(`Adax heater initialized (${ip})`);
  }

  async onUninit() {
    this.dispose();
  }

  async onDeleted() {
    this.dispose();
  }

  private dispose() {
    this.disposed = true;
    this.stopPolling();
    this.controller?.dispose();
  }

  async onSettings({ newSettings, changedKeys }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('ip')) {
      const ip = String(newSettings.ip ?? '').trim();
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('errors.invalid_ip'));
      const probe = new LocalClient({ ip, token: this.getStoreValue('token'), retries: 0, timeoutMs: 8000 });
      try {
        await probe.getStatus();
      } catch (err) {
        throw new Error(this.homey.__('errors.no_answer', { ip, message: (err as Error).message }));
      }
      await this.setStoreValue('ip', ip);
      this.client.setConnection(ip);
    }
    if (changedKeys.includes('local_changes')) {
      this.log(`Local changes mode: ${parseLocalChangeMode(newSettings.local_changes)}`);
    }
    // Settings are saved after onSettings returns.
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this.startPolling(), 0);
    }
    this.homey.setTimeout(() => this.poll(), 0);
  }

  getLocalChangeMode(): LocalChangeMode {
    return parseLocalChangeMode(this.getSetting('local_changes'));
  }

  /** Flow action. Switching from allow to lock/limit locks the current state. */
  async setLocalChangeMode(mode: LocalChangeMode) {
    if (this.getLocalChangeMode() === mode) return;
    await this.setSettings({ local_changes: mode });
    this.log(`Local changes mode: ${mode} (Flow)`);
  }

  /** Update IP/token (after repair or rediscovery) and refresh state. */
  async applyConnection(ip: string, token: string = this.getStoreValue('token')) {
    await this.setStoreValue('ip', ip);
    await this.setStoreValue('token', token);
    await this.setSettings({ ip });
    this.client.setConnection(ip, token);
    this.controller.resetFailures();
    await this.controller.poll();
  }

  /**
   * Search the local /24 network(s) for this heater (by TLS certificate CN and
   * token). Updates the stored IP when found. The network scan is shared by
   * all heaters (see the driver).
   * @param fresh do not reuse a recent scan (manual repair)
   */
  async rediscover(fresh = false): Promise<string | null> {
    if (this.rediscovering) return this.rediscovering;
    this.rediscovering = (async () => {
      this.lastRediscovery = Date.now();
      const driver = this.driver as AdaxHeaterDriver;
      const ip = await driver.findHeaterOnNetwork(this.getStoreValue('token'), fresh);
      if (this.disposed) return null;
      if (ip) {
        this.log(`Heater found at ${ip}`);
        await this.applyConnection(ip);
      } else {
        this.log('Heater not found on the network');
      }
      return ip;
    })().finally(() => {
      this.rediscovering = null;
    });
    return this.rediscovering;
  }

  /**
   * Read the undocumented `info` command (model + firmware) on startup and
   * show it in the device settings. Failures are harmless.
   */
  private async readDeviceInfo() {
    try {
      const body = await this.client.rawCommand('info');
      const info = JSON.parse(body) as { version?: { firmware?: string }; device?: { product?: string } };
      // Only log the fields used; the full response may contain network details.
      this.log(`info: product=${info.device?.product ?? '?'} firmware=${info.version?.firmware ?? '?'}`);
      const settings: Record<string, string> = {};
      if (info.device?.product) settings.model = info.device.product;
      if (info.version?.firmware) settings.firmware = info.version.firmware;
      if (Object.keys(settings).length) await this.setSettings(settings);
    } catch (err) {
      this.log(`info failed: ${(err as Error).message}`);
    }
  }

  private startPolling() {
    this.stopPolling();
    if (this.disposed) return;
    const seconds = clamp(Number(this.getSetting('poll_interval')) || 60, 30, 600);
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
  }

  private stopPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private poll() {
    this.controller.poll().catch(this.error);
  }

  private unavailableMessage(err: unknown): string {
    if (isAuthError(err)) return this.homey.__('errors.unauthorized');
    if (err instanceof AdaxHttpError) {
      return this.homey.__('errors.http', { status: err.statusCode });
    }
    return this.homey.__('errors.unreachable');
  }

  private async onCapabilities(values: { onoff?: boolean; target_temperature?: number }) {
    try {
      await this.controller.setFromHomey(
        values,
        this.getCapabilityValue('target_temperature'),
        { deadlineMs: UI_WRITE_DEADLINE_MS },
      );
    } catch (err) {
      this.error(`Set target failed: ${(err as Error).message}`);
      if (err instanceof AdaxHttpError) throw new Error(this.unavailableMessage(err));
      throw new Error(this.homey.__('errors.write_timeout', { ip: this.client.address }));
    }
  }

  private async publish(status: AdaxStatus) {
    await this.setCapabilityValue('measure_temperature', status.currentC).catch(this.error);
    // Without a rated power there is no estimate: show "–" instead of a misleading 0 W.
    const ratedPower = Number(this.getSetting('rated_power')) || 0;
    const power = ratedPower > 0 ? estimatePowerW(ratedPower, status.targetC, status.currentC) : null;
    await this.setCapabilityValue('measure_power', power).catch(this.error);
    if (status.targetC > 0) {
      await this.setCapabilityValue('onoff', true).catch(this.error);
      await this.setCapabilityValue('target_temperature', clampTarget(status.targetC)).catch(this.error);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }
  }

  private async onPollFailed(err: unknown, failures: number) {
    if (failures < FAILURES_BEFORE_UNAVAILABLE) return;
    await this.setUnavailable(this.unavailableMessage(err)).catch(this.error);
    // A network error may mean the heater got a new IP from DHCP.
    const isNetworkError = !(err instanceof AdaxHttpError);
    if (isNetworkError && Date.now() - this.lastRediscovery > REDISCOVERY_INTERVAL_MS) {
      this.rediscover().catch(this.error);
    }
  }

  private async onLocalChange(change: LocalChange) {
    const driver = this.driver as AdaxHeaterDriver;
    await driver.triggerLocalChange(this, {
      temperature: change.heaterTargetC,
      corrected: change.correctionC !== null,
    });
  }

  private createHost(): HeaterHost {
    return {
      mode: () => this.getLocalChangeMode(),
      load: (key: StoreKey) => {
        const value = this.getStoreValue(key);
        return typeof value === 'number' ? value : null;
      },
      save: (key: StoreKey, value: number) => this.setStoreValue(key, value),
      publish: (status) => this.publish(status),
      pollSucceeded: async () => {
        if (!this.getAvailable()) await this.setAvailable().catch(this.error);
      },
      pollFailed: (err, failures) => this.onPollFailed(err, failures),
      writeConfirmed: () => this.unsetWarning().catch(this.error),
      writeNotConfirmed: () => this.setWarning(this.homey.__('errors.not_confirmed')).catch(this.error),
      localChange: (change) => this.onLocalChange(change),
      sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    };
  }
}

export = AdaxHeaterDevice;
