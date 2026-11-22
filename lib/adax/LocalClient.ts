import https from 'node:https';
import { ADAX_LOCAL_PORT } from './constants';

export interface AdaxStatus {
  /** Target temperature in °C. 0 means the heater is off. */
  targetC: number;
  /** Measured room temperature in °C. */
  currentC: number;
  /** Current power draw in W (`pow`), or null if not reported. */
  powerW: number | null;
  /** Energy counter in Wh (`energ`), or null if not reported. Resets e.g. on power cycle. */
  energyWh: number | null;
  /** Raw JSON response, for diagnostics. */
  raw: Record<string, unknown>;
}

export class AdaxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdaxTimeoutError';
  }
}

export interface RequestOptions {
  /**
   * Total time budget (ms) including time waiting in the queue and retries.
   * Used for writes from Homey, which times out after 10 s.
   */
  deadlineMs?: number;
}

export class AdaxHttpError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`Adax heater responded with HTTP ${statusCode}`);
    this.name = 'AdaxHttpError';
  }
}

/**
 * HTTP statuses that mean the heater rejected the token. Heaters tested with
 * this app (fw 2.0.1.8 / 2.0.2.27) answer 405 to a wrong token; 401/403 are
 * kept for other firmware.
 */
const AUTH_ERROR_STATUSES: ReadonlySet<number> = new Set([401, 403, 405]);

/** True when the heater rejected the token (repair needed). */
export function isAuthError(err: unknown): err is AdaxHttpError {
  return err instanceof AdaxHttpError && AUTH_ERROR_STATUSES.has(err.statusCode);
}

export interface LocalClientOptions {
  ip: string;
  token: string;
  port?: number;
  /** Per-request timeout. Default 10 s (slow heaters need ~3 s incl. TLS handshake). */
  timeoutMs?: number;
  /** Retries for network errors / 5xx. Default 2. */
  retries?: number;
  /** Delay before retry n is `retryDelayMs * n`. Default 1000 ms. */
  retryDelayMs?: number;
}

type Params = Record<string, string | number>;

// Heaters use self-signed certificates. Keep-alive matters: the TLS handshake
// takes 1–2.5 s on these heaters, a reused connection ~10 ms. maxSockets 1 per
// heater, since the heater handles concurrent connections badly. Idle sockets
// are dropped after 20 s; a socket the heater closed is retried (network error).
const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 1,
  timeout: 20000,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client for the Adax local API (`https://<ip>/api`).
 *
 * All requests are serialized: the heater becomes unstable when it receives
 * several requests at once.
 */
export class LocalClient {
  private queue: Promise<unknown> = Promise.resolve();
  private ip: string;
  private token: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: LocalClientOptions) {
    this.ip = options.ip;
    this.token = options.token;
    this.port = options.port ?? ADAX_LOCAL_PORT;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  get address(): string {
    return this.ip;
  }

  setConnection(ip: string, token: string = this.token): void {
    this.ip = ip;
    this.token = token;
  }

  async getStatus(): Promise<AdaxStatus> {
    const body = await this.enqueue(() => this.requestWithRetry({ command: 'stat' }));
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`Invalid JSON from heater: ${body.slice(0, 200)}`);
    }
    const targ = Number(json.targTemp);
    const curr = Number(json.currTemp);
    if (!Number.isFinite(targ) || !Number.isFinite(curr)) {
      throw new Error(`Unexpected status from heater: ${body.slice(0, 200)}`);
    }
    const optional = (v: unknown) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
      targetC: targ / 100,
      currentC: curr / 100,
      powerW: optional(json.pow),
      energyWh: optional(json.energ),
      raw: json,
    };
  }

  /**
   * Send an arbitrary command and return the raw response body (diagnostics only,
   * e.g. the undocumented `info` command). Not retried.
   */
  async rawCommand(command: string, params: Record<string, string | number> = {}): Promise<string> {
    return this.enqueue(() => this.request({ ...params, command }));
  }

  /** Set target temperature in °C. 0 turns the heater off. */
  async setTarget(celsius: number, options: RequestOptions = {}): Promise<void> {
    const value = Math.round(celsius * 100);
    const deadline = options.deadlineMs ? Date.now() + options.deadlineMs : undefined;
    await this.enqueue(() => this.requestWithRetry({ command: 'set_target', value }, deadline));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Minimum time worth starting a request with when a deadline applies. */
  private static readonly MIN_ATTEMPT_MS = 1000;

  private async requestWithRetry(params: Params, deadline?: number): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * attempt);
      let timeoutMs = this.timeoutMs;
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining < LocalClient.MIN_ATTEMPT_MS) {
          throw lastError ?? new AdaxTimeoutError(`No time left to contact ${this.ip} (heater busy or not responding)`);
        }
        timeoutMs = Math.min(timeoutMs, remaining);
      }
      try {
        return await this.request(params, timeoutMs);
      } catch (err) {
        lastError = err;
        // 4xx will not get better by retrying (bad token, broken firmware).
        if (err instanceof AdaxHttpError && err.statusCode < 500) throw err;
      }
    }
    throw lastError;
  }

  private request(params: Params, timeoutMs: number = this.timeoutMs): Promise<string> {
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      time: String(Math.floor(Date.now() / 1000)),
    });
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.ip,
          port: this.port,
          path: `/api?${query.toString()}`,
          method: 'GET',
          agent: insecureAgent,
          headers: { Authorization: `Basic ${this.token}` },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(body);
            else reject(new AdaxHttpError(status, body));
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new AdaxTimeoutError(`Timeout after ${timeoutMs} ms contacting ${this.ip}`)));
      req.on('error', reject);
      req.end();
    });
  }
}
