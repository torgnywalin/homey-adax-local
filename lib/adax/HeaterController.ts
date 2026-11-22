import type { AdaxStatus, RequestOptions } from './LocalClient';
import {
  clampTarget,
  correctLocalChange,
  LocalChangeMode,
  sameTarget,
  targetFromCapabilities,
} from './policy';

/** The part of `LocalClient` the controller uses. */
export interface HeaterClient {
  getStatus(): Promise<AdaxStatus>;
  setTarget(celsius: number, options?: RequestOptions): Promise<void>;
}

/**
 * Persisted values (Homey device store):
 * - homeyTarget:   last target set from Homey (0 = off), reference for lock
 * - homeyOnTarget: last non-zero target set from Homey, reference for limit
 * - lastTarget:    last non-zero target reported by the heater
 */
export type StoreKey = 'homeyTarget' | 'homeyOnTarget' | 'lastTarget';

export interface LocalChange {
  /** Target the heater was changed to outside Homey (0 = off). */
  heaterTargetC: number;
  /** Target Homey writes back, or null when the change is kept. */
  correctionC: number | null;
  mode: LocalChangeMode;
}

/** Everything the controller needs from Homey. Implemented by the device. */
export interface HeaterHost {
  mode(): LocalChangeMode;
  load(key: StoreKey): number | null;
  save(key: StoreKey, value: number): Promise<void>;
  /** Show a status in Homey (capabilities). */
  publish(status: AdaxStatus): Promise<void>;
  pollSucceeded(): Promise<void>;
  pollFailed(err: unknown, consecutiveFailures: number): Promise<void>;
  writeConfirmed(): Promise<void>;
  writeNotConfirmed(): Promise<void>;
  /** The heater's target changed outside Homey (buttons on the heater). */
  localChange(change: LocalChange): Promise<void>;
  /** Timer that is cleaned up when the device/app stops (homey.setTimeout). */
  sleep(ms: number): Promise<void>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface HeaterControllerOptions {
  /** Read-backs after a write; the heater is resent the target between them. Default 3. */
  confirmAttempts?: number;
  /** Delay before read-back n is `confirmDelayMs * n`. Default 1000 ms. */
  confirmDelayMs?: number;
}

/**
 * Polling, writing and lock/limit enforcement for one heater, without Homey
 * dependencies so it can be unit tested.
 *
 * Writes return as soon as the heater accepted the request and are confirmed
 * in the background (slow heaters need several seconds per request, and Homey
 * gives up on a capability change after 10 s).
 *
 * A poll whose result may predate a write is discarded, so the UI does not
 * jump back to the old value and flows are not triggered twice.
 */
export class HeaterController {
  private failures = 0;
  private writeSeq = 0;
  private confirming = 0;
  private polling: Promise<void> | null = null;
  /** Last target seen from (or accepted by) the heater, to detect changes made on it. Not persisted. */
  private lastSeenTargetC: number | null = null;
  private lastRawStatus = '';
  private disposed = false;
  private readonly confirmAttempts: number;
  private readonly confirmDelayMs: number;

  constructor(
    private readonly client: HeaterClient,
    private readonly host: HeaterHost,
    options: HeaterControllerOptions = {},
  ) {
    this.confirmAttempts = options.confirmAttempts ?? 3;
    this.confirmDelayMs = options.confirmDelayMs ?? 1000;
  }

  /** Stop background work (confirmation) and ignore results still in flight. */
  dispose(): void {
    this.disposed = true;
    this.writeSeq++;
  }

  /** Reset the failure counter, e.g. after the connection was changed. */
  resetFailures(): void {
    this.failures = 0;
  }

  /** Read the status once. A poll already in progress is reused instead of queueing another. */
  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.doPoll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  /**
   * Apply a capability change from Homey. Resolves when the heater accepted
   * the new target; throws the client error otherwise.
   * @returns the target written (0 = off)
   */
  async setFromHomey(
    values: { onoff?: boolean; target_temperature?: number },
    capabilityTargetC: number | null,
    options: RequestOptions = {},
  ): Promise<number> {
    const target = targetFromCapabilities(values, [
      this.host.load('homeyOnTarget'),
      this.host.load('lastTarget'),
      capabilityTargetC,
    ]);
    // Remember Homey's intent BEFORE writing, so a poll running concurrently
    // does not treat the new value as a local change and revert it.
    await this.rememberHomeyTarget(target, target > 0 ? target : null);
    await this.writeTarget(target, options);
    return target;
  }

  private async doPoll(): Promise<void> {
    const seq = this.writeSeq;
    let status: AdaxStatus;
    try {
      status = await this.client.getStatus();
    } catch (err) {
      if (this.disposed) return;
      this.failures++;
      this.host.error(`Poll failed (${this.failures}): ${(err as Error).message}`);
      await this.host.pollFailed(err, this.failures);
      return;
    }
    if (this.disposed) return;
    this.failures = 0;
    const raw = JSON.stringify(status.raw);
    if (raw !== this.lastRawStatus) {
      this.host.log(`stat: ${raw}`);
      this.lastRawStatus = raw;
    }
    await this.host.pollSucceeded();

    if (seq !== this.writeSeq || this.confirming > 0) {
      // The status may predate a write; the confirmation applies the real state.
      return;
    }
    await this.handleStatus(status);
  }

  /** Apply a polled status, correcting changes made on the heater when locked/limited. */
  private async handleStatus(status: AdaxStatus): Promise<void> {
    const mode = this.host.mode();
    let homeyTarget = this.host.load('homeyTarget');
    let homeyOnTarget = this.host.load('homeyOnTarget');
    const previous = this.lastSeenTargetC;
    this.lastSeenTargetC = status.targetC;
    const changedLocally = previous !== null && !sameTarget(previous, status.targetC);

    // In "allow" mode (and on first run) Homey follows the heater, so switching
    // to lock/limit later locks the current state.
    if (mode === 'allow' || homeyTarget === null) {
      homeyTarget = status.targetC;
      if (status.targetC > 0) homeyOnTarget = status.targetC;
      await this.rememberHomeyTarget(homeyTarget, homeyOnTarget);
    }

    const correction = correctLocalChange(mode, status.targetC, homeyTarget, homeyOnTarget);
    if (changedLocally) {
      await this.host.localChange({ heaterTargetC: status.targetC, correctionC: correction, mode })
        .catch((err) => this.host.error(err));
    }
    if (correction === null) {
      await this.apply(status);
      return;
    }

    // Don't publish the local change (would trigger flows); the confirmation applies the real state.
    this.host.log(`Heater changed locally to ${status.targetC} °C (${mode}), setting ${correction} °C`);
    try {
      await this.writeTarget(correction);
    } catch (err) {
      this.host.error(`Could not correct local change: ${(err as Error).message}`);
      await this.apply(status);
    }
  }

  private async rememberHomeyTarget(target: number, onTarget: number | null): Promise<void> {
    if (this.host.load('homeyTarget') !== target) await this.host.save('homeyTarget', target);
    if (onTarget !== null && this.host.load('homeyOnTarget') !== onTarget) {
      await this.host.save('homeyOnTarget', onTarget);
    }
  }

  private async apply(status: AdaxStatus): Promise<void> {
    this.lastSeenTargetC = status.targetC;
    await this.host.publish(status);
    if (status.targetC > 0) {
      const target = clampTarget(status.targetC);
      if (this.host.load('lastTarget') !== target) await this.host.save('lastTarget', target);
    }
  }

  /** Send a target (0 = off) and confirm it in the background. */
  private async writeTarget(target: number, options: RequestOptions = {}): Promise<void> {
    // Bump before sending: a poll queued ahead of this write must be discarded.
    const seq = ++this.writeSeq;
    this.host.log(`set_target ${target} °C`);
    await this.client.setTarget(target, options);
    this.failures = 0;
    this.lastSeenTargetC = target;
    this.confirmTarget(target, seq).catch((err) => this.host.error(err));
  }

  private superseded(seq: number): boolean {
    return this.disposed || seq !== this.writeSeq;
  }

  /** Read back the target; resend if the heater ignored it. Superseded by newer writes. */
  private async confirmTarget(target: number, seq: number): Promise<void> {
    this.confirming++;
    try {
      for (let attempt = 1; attempt <= this.confirmAttempts; attempt++) {
        await this.host.sleep(this.confirmDelayMs * attempt);
        if (this.superseded(seq)) return;
        try {
          const status = await this.client.getStatus();
          if (this.superseded(seq)) return;
          if (sameTarget(status.targetC, target)) {
            await this.apply(status);
            await this.host.writeConfirmed();
            return;
          }
          this.host.log(`Heater reports target ${status.targetC} after setting ${target} (attempt ${attempt})`, status.raw);
          if (attempt < this.confirmAttempts) {
            this.host.log(`set_target ${target} °C (retry ${attempt})`);
            await this.client.setTarget(target);
          } else {
            await this.apply(status);
          }
        } catch (err) {
          this.host.error(`Confirming target failed (attempt ${attempt}): ${(err as Error).message}`);
        }
      }
      if (!this.superseded(seq)) await this.host.writeNotConfirmed();
    } finally {
      this.confirming--;
    }
  }
}
