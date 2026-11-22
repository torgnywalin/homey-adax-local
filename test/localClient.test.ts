import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdaxHttpError, AdaxTimeoutError, isAuthError, LocalClient } from '../lib/adax/LocalClient';
import { findHeater, probeCertificateCN } from '../lib/adax/scan';

const TOKEN = '0123456789abcdef0123';

/** Mock heater implementing the documented Adax local API. */
class MockHeater {
  server!: https.Server;
  port = 0;
  targTemp = 2100;
  currTemp = 1987;
  pow = 1200;
  energ = 3456;
  requests: URL[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  failNext = 0;
  delayMs = 20;

  async start(cn: string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'adax-test-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', `/CN=${cn}`,
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      ], { stdio: 'ignore' });
      this.server = https.createServer({
        key: readFileSync(path.join(dir, 'key.pem')),
        cert: readFileSync(path.join(dir, 'cert.pem')),
      }, (req, res) => this.handle(req, res));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'https://heater');
    this.requests.push(url);
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    setTimeout(() => {
      this.concurrent--;
      if (this.failNext > 0) {
        this.failNext--;
        res.writeHead(500).end('error');
        return;
      }
      if (req.headers.authorization !== `Basic ${TOKEN}`) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (url.pathname !== '/api' || !url.searchParams.get('time')) {
        res.writeHead(400).end('bad request');
        return;
      }
      const command = url.searchParams.get('command');
      if (command === 'stat') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ targTemp: this.targTemp, currTemp: this.currTemp, energ: this.energ, pow: this.pow }));
      } else if (command === 'set_target') {
        this.targTemp = Number(url.searchParams.get('value'));
        res.writeHead(200).end();
      } else {
        res.writeHead(400).end('bad request');
      }
    }, this.delayMs);
  }
}

const heater = new MockHeater();
const otherServer = new MockHeater();

before(async () => {
  await heater.start('ADAX DEVICE');
  await otherServer.start('router.local');
});

after(async () => {
  await heater.stop();
  await otherServer.stop();
});

const client = (token = TOKEN, port = heater.port) => new LocalClient({ ip: '127.0.0.1', port, token, retryDelayMs: 10 });

test('getStatus converts centi-degrees to °C', async () => {
  heater.targTemp = 2100;
  heater.currTemp = 1987;
  const status = await client().getStatus();
  assert.equal(status.targetC, 21);
  assert.equal(status.currentC, 19.87);
  assert.equal(status.powerW, 1200);
  assert.equal(status.energyWh, 3456);
  const last = heater.requests.at(-1)!;
  assert.equal(last.searchParams.get('command'), 'stat');
  assert.match(last.searchParams.get('time')!, /^\d{10}$/);
});

test('setTarget sends °C × 100, and 0 turns off', async () => {
  const c = client();
  await c.setTarget(22.5);
  assert.equal(heater.targTemp, 2250);
  assert.equal(heater.requests.at(-1)!.searchParams.get('value'), '2250');
  await c.setTarget(0);
  assert.equal((await c.getStatus()).targetC, 0);
});

test('wrong token gives AdaxHttpError 401 without retries', async () => {
  const before = heater.requests.length;
  await assert.rejects(client('wrong').getStatus(), (err: unknown) => err instanceof AdaxHttpError && err.statusCode === 401);
  assert.equal(heater.requests.length - before, 1);
});

test('5xx is retried', async () => {
  heater.failNext = 2;
  heater.targTemp = 1800;
  const status = await client().getStatus();
  assert.equal(status.targetC, 18);
});

test('requests are serialized', async () => {
  heater.maxConcurrent = 0;
  const c = client();
  await Promise.all([c.getStatus(), c.setTarget(20), c.getStatus(), c.getStatus()]);
  assert.equal(heater.maxConcurrent, 1);
});

test('network error rejects', async () => {
  const c = new LocalClient({ ip: '127.0.0.1', port: 1, token: TOKEN, retries: 0, timeoutMs: 1000 });
  await assert.rejects(c.getStatus());
});

test('probeCertificateCN reads the certificate subject', async () => {
  assert.equal(await probeCertificateCN('127.0.0.1', heater.port), 'ADAX DEVICE');
  assert.equal(await probeCertificateCN('127.0.0.1', otherServer.port), 'router.local');
  assert.equal(await probeCertificateCN('127.0.0.1', 1, 500), null);
});

test('findHeater only sends the token to hosts with the Adax certificate', async () => {
  otherServer.requests = [];
  assert.equal(await findHeater(['127.0.0.1'], TOKEN, { port: heater.port }), '127.0.0.1');
  assert.equal(await findHeater(['127.0.0.1'], 'wrong-token', { port: heater.port }), null);
  assert.equal(await findHeater(['127.0.0.1'], TOKEN, { port: otherServer.port }), null);
  assert.equal(otherServer.requests.length, 0);
});

test('setTarget with deadline fails fast when the heater is slow', async () => {
  heater.delayMs = 3000;
  try {
    const c = new LocalClient({ ip: '127.0.0.1', port: heater.port, token: TOKEN, retryDelayMs: 10, timeoutMs: 10000 });
    const start = Date.now();
    await assert.rejects(c.setTarget(21, { deadlineMs: 1500 }), (err: unknown) => err instanceof AdaxTimeoutError);
    assert.ok(Date.now() - start < 2500, `took ${Date.now() - start} ms`);
  } finally {
    heater.delayMs = 20;
  }
});

test('a write queued behind a slow request respects its deadline', async () => {
  heater.delayMs = 2500;
  try {
    const c = new LocalClient({ ip: '127.0.0.1', port: heater.port, token: TOKEN, retries: 0, timeoutMs: 10000 });
    const poll = c.getStatus();
    const start = Date.now();
    await assert.rejects(c.setTarget(21, { deadlineMs: 2000 }), (err: unknown) => err instanceof AdaxTimeoutError);
    assert.ok(Date.now() - start < 3500, `took ${Date.now() - start} ms`);
    await poll;
  } finally {
    heater.delayMs = 20;
  }
});

test('isAuthError: 401, 403 and 405 (wrong token on real heaters) mean the token was rejected', () => {
  for (const status of [401, 403, 405]) assert.equal(isAuthError(new AdaxHttpError(status, '')), true, String(status));
  for (const status of [400, 404, 500]) assert.equal(isAuthError(new AdaxHttpError(status, '')), false, String(status));
  assert.equal(isAuthError(new Error('ECONNREFUSED')), false);
});
