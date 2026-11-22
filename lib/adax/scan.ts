import net from 'node:net';
import tls from 'node:tls';
import { ADAX_CERT_CN, ADAX_LOCAL_PORT } from './constants';
import { LocalClient } from './LocalClient';

/** All host addresses (.1–.254) in the /24 of the given IPv4 address. */
export function subnetCandidates(ip: string): string[] {
  if (net.isIPv4(ip) === false) return [];
  const prefix = ip.split('.').slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
}

/**
 * Open a TLS connection and return the certificate subject CN, or null if
 * nothing answers on the port within the timeout.
 */
export function probeCertificateCN(ip: string, port = ADAX_LOCAL_PORT, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect({ host: ip, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const cn = cert?.subject?.CN;
      finish(Array.isArray(cn) ? cn[0] ?? null : cn ?? null);
    });
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
  });
}

export interface FindHeaterOptions {
  port?: number;
  concurrency?: number;
  probeTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * Find the heater that accepts `token` among the candidate IPs.
 *
 * Only hosts presenting the Adax certificate (CN "ADAX DEVICE") are sent the
 * token, so it is never leaked to other HTTPS servers on the LAN.
 */
export async function findHeater(candidates: string[], token: string, options: FindHeaterOptions = {}): Promise<string | null> {
  const port = options.port ?? ADAX_LOCAL_PORT;
  const concurrency = options.concurrency ?? 32;
  const probeTimeoutMs = options.probeTimeoutMs ?? 4000; // old heaters need ~2.5 s for the TLS handshake
  const log = options.log ?? (() => undefined);

  const unique = [...new Set(candidates)];
  const adaxHosts: string[] = [];
  let index = 0;
  const worker = async () => {
    while (index < unique.length) {
      const ip = unique[index++];
      const cn = await probeCertificateCN(ip, port, probeTimeoutMs);
      if (cn === ADAX_CERT_CN) adaxHosts.push(ip);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  log(`Found ${adaxHosts.length} Adax heater(s) on the network: ${adaxHosts.join(', ')}`);

  for (const ip of adaxHosts) {
    const client = new LocalClient({ ip, token, port, retries: 0, timeoutMs: 5000 });
    try {
      await client.getStatus();
      return ip;
    } catch (err) {
      log(`Heater at ${ip} rejected token: ${(err as Error).message}`);
    }
  }
  return null;
}
