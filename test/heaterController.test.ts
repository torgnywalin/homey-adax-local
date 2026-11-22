import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeaterController, HeaterHost, LocalChange, StoreKey } from '../lib/adax/HeaterController';
import type { AdaxStatus } from '../lib/adax/LocalClient';
import type { LocalChangeMode } from '../lib/adax/policy';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fake heater: serialized like the real client; reads can be held to simulate a slow heater. */
class FakeHeater {
  targetC = 20;
  currentC = 19;
  /** Ignore the next n set_target requests (heater "forgets" the write). */
  ignoreWrites = 0;
  failReads = false;
  writes: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  /** Hold every read until `release()` (the status is captured when the read starts). */
  hold() {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release() {
    this.openGate?.();
    this.gate = null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  getStatus(): Promise<AdaxStatus> {
    return this.enqueue(async () => {
      if (this.failReads) throw new Error('ECONNREFUSED');
      const status = { targetC: this.targetC, currentC: this.currentC, powerW: null, energyWh: null, raw: { targTemp: this.targetC * 100 } };
      if (this.gate) await this.gate;
      return status;
    });
  }

  setTarget(celsius: number): Promise<void> {
    return this.enqueue(async () => {
      this.writes.push(celsius);
      if (this.ignoreWrites > 0) {
        this.ignoreWrites--;
        return;
      }
      this.targetC = celsius;
    });
  }
}

class FakeHost implements HeaterHost {
  modeValue: LocalChangeMode = 'allow';
  store = new Map<StoreKey, number>();
  published: number[] = [];
  changes: LocalChange[] = [];
  failures: number[] = [];
  confirmed = 0;
  notConfirmed = 0;
  errors: unknown[] = [];

  mode() { return this.modeValue; }
  load(key: StoreKey) { return this.store.get(key) ?? null; }
  async save(key: StoreKey, value: number) { this.store.set(key, value); }
  async publish(status: AdaxStatus) { this.published.push(status.targetC); }
  async pollSucceeded() {}
  async pollFailed(_err: unknown, n: number) { this.failures.push(n); }
  async writeConfirmed() { this.confirmed++; }
  async writeNotConfirmed() { this.notConfirmed++; }
  async localChange(change: LocalChange) { this.changes.push(change); }
  sleep() { return tick(); }
  log() {}
  error(...args: unknown[]) { this.errors.push(args); }
}

function setup(mode: LocalChangeMode = 'allow') {
  const heater = new FakeHeater();
  const host = new FakeHost();
  host.modeValue = mode;
  const controller = new HeaterController(heater, host, { confirmAttempts: 3, confirmDelayMs: 0 });
  return { heater, host, controller };
}

/** Let background confirmation finish. */
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

test('first poll publishes and remembers the heater state', async () => {
  const { host, controller } = setup();
  await controller.poll();
  assert.deepEqual(host.published, [20]);
  assert.equal(host.load('homeyTarget'), 20);
  assert.equal(host.load('homeyOnTarget'), 20);
  assert.equal(host.load('lastTarget'), 20);
  assert.deepEqual(host.changes, [], 'first poll is not a local change');
});

test('concurrent polls are coalesced', async () => {
  const { heater, controller } = setup();
  let reads = 0;
  const original = heater.getStatus.bind(heater);
  heater.getStatus = () => { reads++; return original(); };
  await Promise.all([controller.poll(), controller.poll(), controller.poll()]);
  assert.equal(reads, 1);
});

test('a poll that started before a write does not publish the old target', async () => {
  const { heater, host, controller } = setup();
  await controller.poll();
  host.published = [];

  heater.hold();
  const poll = controller.poll(); // reads 20, held
  await tick();
  const write = controller.setFromHomey({ target_temperature: 23 }, 20);
  heater.release();
  await Promise.all([poll, write]);
  await settle();

  assert.deepEqual(host.published, [23], 'only the confirmed value is published');
  assert.equal(host.load('homeyTarget'), 23, 'allow mode keeps Homey intent');
  assert.deepEqual(host.changes, [], 'no local change detected');
  assert.equal(host.confirmed, 1);
});

test('setFromHomey: off, on with last target, and clamping', async () => {
  const { heater, host, controller } = setup();
  await controller.poll();

  assert.equal(await controller.setFromHomey({ onoff: false }, 20), 0);
  await settle();
  assert.equal(heater.targetC, 0);
  assert.equal(host.load('homeyOnTarget'), 20, 'off keeps the last on-target');

  assert.equal(await controller.setFromHomey({ onoff: true }, 20), 20);
  await settle();
  assert.equal(heater.targetC, 20);

  assert.equal(await controller.setFromHomey({ target_temperature: 40 }, 20), 35);
  assert.equal(await controller.setFromHomey({ target_temperature: 21.6 }, 20), 22);
});

test('a write the heater ignored is resent', async () => {
  const { heater, host, controller } = setup();
  await controller.poll();
  heater.ignoreWrites = 1;
  await controller.setFromHomey({ target_temperature: 24 }, 20);
  await settle();
  assert.deepEqual(heater.writes, [24, 24]);
  assert.equal(heater.targetC, 24);
  assert.equal(host.confirmed, 1);
  assert.equal(host.notConfirmed, 0);
});

test('a write that is never applied raises a warning and publishes the real state', async () => {
  const { heater, host, controller } = setup();
  await controller.poll();
  host.published = [];
  heater.ignoreWrites = 10;
  await controller.setFromHomey({ target_temperature: 24 }, 20);
  await settle();
  assert.equal(host.notConfirmed, 1);
  assert.deepEqual(host.published, [20]);
});

test('lock: a change on the heater is reverted and triggers local change', async () => {
  const { heater, host, controller } = setup('lock');
  await controller.poll();
  heater.targetC = 26;
  await controller.poll();
  await settle();
  assert.equal(heater.targetC, 20);
  assert.deepEqual(host.changes, [{ heaterTargetC: 26, correctionC: 20, mode: 'lock' }]);
  assert.ok(!host.published.includes(26), 'the local change is not published');

  await controller.poll();
  assert.equal(host.changes.length, 1, 'the correction itself is not a local change');
});

test('allow: a change on the heater is kept and triggers local change', async () => {
  const { heater, host, controller } = setup('allow');
  await controller.poll();
  heater.targetC = 0;
  await controller.poll();
  assert.deepEqual(host.changes, [{ heaterTargetC: 0, correctionC: null, mode: 'allow' }]);
  assert.equal(host.load('homeyTarget'), 0);
  assert.equal(host.load('homeyOnTarget'), 20);
  assert.deepEqual(heater.writes, []);
});

test('limit: a large change is clamped to ±3 °C', async () => {
  const { heater, host, controller } = setup('limit');
  await controller.poll();
  heater.targetC = 30;
  await controller.poll();
  await settle();
  assert.equal(heater.targetC, 23);
  assert.equal(host.changes[0].correctionC, 23);
});

test('poll failures are counted and reset on success', async () => {
  const { heater, host, controller } = setup();
  heater.failReads = true;
  await controller.poll();
  await controller.poll();
  assert.deepEqual(host.failures, [1, 2]);
  heater.failReads = false;
  await controller.poll();
  heater.failReads = true;
  await controller.poll();
  assert.deepEqual(host.failures, [1, 2, 1]);
});

test('dispose stops confirmation and ignores polls in flight', async () => {
  const { heater, host, controller } = setup();
  await controller.poll();
  host.published = [];
  await controller.setFromHomey({ target_temperature: 22 }, 20);
  controller.dispose();
  await settle();
  assert.equal(host.confirmed, 0);

  heater.hold();
  const poll = controller.poll();
  heater.release();
  await poll;
  assert.deepEqual(host.published, []);
});
