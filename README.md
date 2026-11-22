# Adax Local for Homey

Control Adax WiFi panel heaters **locally** from Homey Pro — no Adax cloud, no internet required.

> [!WARNING]
> A heater set up with this app is removed from the Adax app/cloud and can no longer be controlled from it.
> This is an unofficial app, not affiliated with or endorsed by Adax AS.

## How it works

1. **Bluetooth provisioning:** Homey generates a private token and sends `command=join&ssid=…&psk=…&token=…` to the heater over BLE (service `3885cc10-7c18-4ad4-a48d-bf11abf7cb92`, characteristic `cc11`, 19-byte chunks). The heater joins WiFi and replies with its IP address (`[0, ip1, ip2, ip3, ip4]`).
2. **Local control:** HTTPS to `https://<ip>/api` with `Authorization: Basic <token>` (self-signed certificate, CN `ADAX DEVICE`).
   - `command=stat` → `{currTemp, targTemp, energ, pow}` (°C × 100)
   - `command=set_target&value=<°C × 100>` (0 = off)
   - `command=info` (undocumented) → model, firmware

The protocol is documented by Adax ([Local API User Guide](https://adax.no/wi-fi/api-development/)) and implemented in [pyAdaxLocal](https://github.com/Danielhiversen/pyAdaxLocal). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

- Pairing over Bluetooth from Homey (or manually with IP + token)
- On/off, target temperature (5–35 °C), measured temperature
- **Changes on the heater:** allow / limit ±3 °C / lock — enforced by Homey at the next poll, since the local API has no lock
- **Estimated power** from the heater's rated power (set in device settings); Homey Energy calculates kWh. The heater does not measure power, and `pow`/`energ` are always 0 locally.
- Finds the heater again if its IP changes (scans the /24 for the Adax certificate, verifies with the token)
- Repair: search the network or provision again over Bluetooth

## Requirements

- Homey Pro (2019, 2023, 2026, mini) — not Homey Cloud/Bridge
- Adax heater with WiFi + Bluetooth thermostat (Gen 2 / Gen 3 "WT3"). Gen 1 (WiFi only) is not supported.
- 2.4 GHz WiFi. A fixed IP (DHCP reservation) is recommended.

Tested with: "WiFi Heater VG11" (fw 2.0.2.27, BLE type 8) and "WiFi Heater BLE" (fw 2.0.1.8).

## Setting up a heater

1. Reset: press **+ and OK** until the display shows "Reset" (Gen 2).
2. Hold **OK** until the blue LED blinks.
3. In Homey: *Add device → Adax Local → Set up over Bluetooth*, pick the heater, enter WiFi name and password.

The blue LED may keep blinking after setup; power-cycling the heater fixes it.

## Development

```bash
npm install
npm test            # unit tests (protocol, policy, HTTPS mock heater)
npm run dev         # run on your Homey Pro with live log (homey app run --remote)
npm run deploy      # test + install permanently (homey app install)
npx homey app validate --level publish
```

| Path | Contents |
|---|---|
| `lib/adax/` | Protocol library without Homey dependencies: advertisement parsing, join command + chunking, notifications, `LocalClient` (keep-alive, serialized requests, deadlines), network scan, lock/power policy. `BleProvisioner` uses Homey's BLE API. |
| `drivers/heater/` | Driver (pairing, repair) and device (polling, background-confirmed writes, lock policy, power estimate). |
| `test/` | `node:test` tests, including a mock heater over HTTPS with a self-signed certificate. |

## License

MIT — see [LICENSE](LICENSE).
