import net from 'node:net';
import Homey from 'homey';
import { AdaxHttpError, AdaxStatus, LocalClient, RequestOptions } from '../../lib/adax/LocalClient';
import { findHeater, subnetCandidates } from '../../lib/adax/scan';
import { correctLocalChange, estimatePowerW, parseLocalChangeMode } from '../../lib/adax/policy';

const MIN_TARGET = 5;
const MAX_TARGET = 35;
const DEFAULT_TARGET = 20;
/** Consecutive poll failures before the device is marked unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Minimum time between automatic network scans for a lost heater. */
const REDISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const WRITE_ATTEMPTS = 3;
/** Homey gives up on a capability change after 10 s; answer well before that. */
const UI_WRITE_DEADLINE_MS = 8500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

class AdaxHeaterDevice extends Homey.Device {
  private client!: LocalClient;
  private pollTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastRediscovery = 0;
  private rediscovering: Promise<string | null> | null = null;
  private lastRawStatus = '';
  private writeSeq = 0;

  async onInit() {
    const { ip, token } = this.getStore() as { ip: string; token: string };
    this.client = new LocalClient({ ip, token });

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
    this.poll().catch(this.error);
    this.readDeviceInfo().catch(this.error);
    this.log(`Adax heater initialized (${ip})`);
  }

  async onUninit() {
    this.stopPolling();
  }

  async onDeleted() {
    this.stopPolling();
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
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this.startPolling(), 0);
    }
    this.homey.setTimeout(() => this.poll().catch(this.error), 0);
  }

  /** Update IP/token (after repair or rediscovery) and refresh state. */
  async applyConnection(ip: string, token: string = this.getStoreValue('token')) {
    await this.setStoreValue('ip', ip);
    await this.setStoreValue('token', token);
    await this.setSettings({ ip });
    this.client.setConnection(ip, token);
    this.failures = 0;
    await this.poll();
  }

  /**
   * Search the local /24 network(s) for this heater (by TLS certificate CN and
   * token). Updates the stored IP when found.
   */
  async rediscover(): Promise<string | null> {
    if (this.rediscovering) return this.rediscovering;
    this.rediscovering = (async () => {
      this.lastRediscovery = Date.now();
      const token: string = this.getStoreValue('token');
      const candidates = subnetCandidates(this.getStoreValue('ip'));
      const homeyAddress = await this.homey.cloud.getLocalAddress().catch(() => '');
      const homeyIp = homeyAddress.split(':')[0];
      if (net.isIPv4(homeyIp)) candidates.push(...subnetCandidates(homeyIp));

      this.log(`Searching ${new Set(candidates).size} addresses for the heater`);
      const ip = await findHeater(candidates, token, { log: this.log.bind(this) });
      if (ip) {
        this.log(`Heater found at ${ip}`);
        await this.applyConnection(ip, token);
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
   * Read the undocumented `info` command (model + firmware) on startup, log it
   * and show it in the device settings. Failures are harmless.
   */
  private async readDeviceInfo() {
    try {
      const body = await this.client.rawCommand('info');
      this.log(`info: ${body.slice(0, 2000)}`);
      const info = JSON.parse(body) as { version?: { firmware?: string }; device?: { product?: string } };
      const settings: Record<string, string> = {};
      if (info.device?.product) settings.model = info.device.product;
      if (info.version?.firmware) settings.firmware = info.version.firmware;
      if (Object.keys(settings).length) await this.setSettings(settings);
    } catch (err) {
      this.log(`info failed: ${(err as Error).message}`, (err as { body?: string }).body ?? '');
    }
  }


  private startPolling() {
    this.stopPolling();
    const seconds = clamp(Number(this.getSetting('poll_interval')) || 60, 30, 600);
    this.pollTimer = this.homey.setInterval(() => this.poll().catch(this.error), seconds * 1000);
  }

  private stopPolling() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    try {
      const status = await this.client.getStatus();
      this.failures = 0;
      const raw = JSON.stringify(status.raw);
      if (raw !== this.lastRawStatus) {
        this.log(`stat: ${raw}`);
        this.lastRawStatus = raw;
      }
      if (!this.getAvailable()) await this.setAvailable();
      await this.handleStatus(status);
    } catch (err) {
      this.failures++;
      this.error(`Poll failed (${this.failures}): ${(err as Error).message}`);
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(this.unavailableMessage(err)).catch(this.error);
        // A network error may mean the heater got a new IP from DHCP.
        const isNetworkError = !(err instanceof AdaxHttpError);
        if (isNetworkError && Date.now() - this.lastRediscovery > REDISCOVERY_INTERVAL_MS) {
          this.rediscover().catch(this.error);
        }
      }
    }
  }

  private unavailableMessage(err: unknown): string {
    if (err instanceof AdaxHttpError) {
      if (err.statusCode === 401 || err.statusCode === 403) return this.homey.__('errors.unauthorized');
      return this.homey.__('errors.http', { status: err.statusCode });
    }
    return this.homey.__('errors.unreachable');
  }

  /** Apply a polled status, correcting changes made on the heater when locked/limited. */
  private async handleStatus(status: AdaxStatus) {
    const mode = parseLocalChangeMode(this.getSetting('local_changes'));
    let homeyTarget: number | null = this.getStoreValue('homeyTarget') ?? null;
    let homeyOnTarget: number | null = this.getStoreValue('homeyOnTarget') ?? null;

    // In "allow" mode (and on first run) Homey follows the heater, so switching
    // to lock/limit later locks the current state.
    if (mode === 'allow' || homeyTarget === null) {
      homeyTarget = status.targetC;
      if (status.targetC > 0) homeyOnTarget = status.targetC;
      await this.rememberHomeyTarget(homeyTarget, homeyOnTarget);
    }

    const correction = correctLocalChange(mode, status.targetC, homeyTarget, homeyOnTarget);
    if (correction === null) {
      await this.applyStatus(status);
      return;
    }

    // Don't publish the local change (would trigger flows); the confirmation applies the real state.
    this.log(`Heater changed locally to ${status.targetC} °C (${mode}), setting ${correction} °C`);
    try {
      await this.writeTarget(correction);
    } catch (err) {
      this.error(`Could not correct local change: ${(err as Error).message}`);
      await this.applyStatus(status);
    }
  }

  private async rememberHomeyTarget(target: number, onTarget: number | null) {
    if (this.getStoreValue('homeyTarget') !== target) await this.setStoreValue('homeyTarget', target);
    if (onTarget !== null && this.getStoreValue('homeyOnTarget') !== onTarget) {
      await this.setStoreValue('homeyOnTarget', onTarget);
    }
  }

  private async applyStatus(status: AdaxStatus) {
    await this.setCapabilityValue('measure_temperature', status.currentC).catch(this.error);
    const ratedPower = Number(this.getSetting('rated_power')) || 0;
    await this.setCapabilityValue('measure_power', estimatePowerW(ratedPower, status.targetC, status.currentC))
      .catch(this.error);
    if (status.targetC > 0) {
      const target = clamp(status.targetC, MIN_TARGET, MAX_TARGET);
      await this.setCapabilityValue('onoff', true).catch(this.error);
      await this.setCapabilityValue('target_temperature', target).catch(this.error);
      if (this.getStoreValue('lastTarget') !== target) await this.setStoreValue('lastTarget', target);
    } else {
      await this.setCapabilityValue('onoff', false).catch(this.error);
    }
  }

  private async onCapabilities(values: { onoff?: boolean; target_temperature?: number }) {
    let target: number;
    if (values.onoff === false) {
      target = 0;
    } else if (typeof values.target_temperature === 'number') {
      // Setting a temperature also turns the heater on.
      target = clamp(Math.round(values.target_temperature), MIN_TARGET, MAX_TARGET);
    } else {
      target = this.getStoreValue('homeyOnTarget')
        ?? this.getStoreValue('lastTarget')
        ?? this.getCapabilityValue('target_temperature')
        ?? DEFAULT_TARGET;
    }
    // Remember Homey's intent BEFORE writing, so a poll running concurrently
    // does not treat the new value as a local change and revert it.
    await this.rememberHomeyTarget(target, target > 0 ? target : null);
    try {
      await this.writeTarget(target, { deadlineMs: UI_WRITE_DEADLINE_MS });
    } catch (err) {
      this.error(`Set target ${target} failed: ${(err as Error).message}`);
      if (err instanceof AdaxHttpError) throw new Error(this.unavailableMessage(err));
      throw new Error(this.homey.__('errors.write_timeout', { ip: this.client.address }));
    }
  }

  /**
   * Send a target (0 = off) and return as soon as the heater accepted the
   * request, so Homey's UI does not time out (slow heaters need several
   * seconds per request). Confirmation runs in the background.
   */
  private async writeTarget(target: number, options: RequestOptions = {}) {
    this.log(`set_target ${target} °C`);
    await this.client.setTarget(target, options);
    this.failures = 0;
    const seq = ++this.writeSeq;
    this.confirmTarget(target, seq).catch(this.error);
  }

  /** Read back the target; resend if the heater ignored it. Superseded by newer writes. */
  private async confirmTarget(target: number, seq: number) {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      await sleep(1000 * attempt);
      if (seq !== this.writeSeq) return;
      try {
        const status = await this.client.getStatus();
        if (seq !== this.writeSeq) return;
        if (Math.round(status.targetC * 100) === Math.round(target * 100)) {
          await this.applyStatus(status);
          await this.unsetWarning().catch(this.error);
          return;
        }
        this.log(`Heater reports target ${status.targetC} after setting ${target} (attempt ${attempt})`, status.raw);
        if (attempt < WRITE_ATTEMPTS) {
          this.log(`set_target ${target} °C (retry ${attempt})`);
          await this.client.setTarget(target);
        } else {
          await this.applyStatus(status);
        }
      } catch (err) {
        this.error(`Confirming target failed (attempt ${attempt}): ${(err as Error).message}`);
      }
    }
    if (seq === this.writeSeq) await this.setWarning(this.homey.__('errors.not_confirmed')).catch(this.error);
  }

}

export = AdaxHeaterDevice;
