/** How changes made with the buttons on the heater itself are handled. */
export type LocalChangeMode = 'allow' | 'limit' | 'lock';

/** Allowed deviation (°C) from the Homey target in `limit` mode. */
export const LIMIT_DELTA_C = 3;

const MIN_TARGET_C = 5;
const MAX_TARGET_C = 35;

export function parseLocalChangeMode(value: unknown): LocalChangeMode {
  return value === 'limit' || value === 'lock' ? value : 'allow';
}

const sameTarget = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/**
 * Decide whether a target set on the heater itself must be corrected.
 *
 * The local API has no lock, so Homey enforces it by writing the target back
 * on the next poll.
 *
 * @param mode           allow | limit | lock
 * @param heaterTargetC  target reported by the heater (0 = off)
 * @param homeyTargetC   last target set from Homey (0 = off), null if unknown
 * @param homeyOnTargetC last non-zero target set from Homey (reference for `limit`), null if unknown
 * @returns the target to write back, or null when no correction is needed
 *
 * - allow: never corrects.
 * - lock:  any difference from the Homey target (including on/off) is reverted.
 * - limit: the heater may be adjusted ±3 °C around the Homey temperature and
 *          may be switched on/off; larger changes are clamped to the limit.
 */
export function correctLocalChange(
  mode: LocalChangeMode,
  heaterTargetC: number,
  homeyTargetC: number | null,
  homeyOnTargetC: number | null,
): number | null {
  if (mode === 'allow' || homeyTargetC === null) return null;

  if (mode === 'lock') {
    return sameTarget(heaterTargetC, homeyTargetC) ? null : homeyTargetC;
  }

  // limit
  const reference = homeyOnTargetC ?? (homeyTargetC > 0 ? homeyTargetC : null);
  if (reference === null || heaterTargetC <= 0) return null;
  const low = Math.max(MIN_TARGET_C, reference - LIMIT_DELTA_C);
  const high = Math.min(MAX_TARGET_C, reference + LIMIT_DELTA_C);
  if (heaterTargetC < low) return low;
  if (heaterTargetC > high) return high;
  return null;
}

/**
 * Estimated power draw. The heater does not report power locally, so assume
 * the element runs at rated power while the heater is on and the room is
 * below target. Homey Energy integrates this into kWh.
 */
export function estimatePowerW(ratedPowerW: number, heaterTargetC: number, currentC: number): number {
  if (!Number.isFinite(ratedPowerW) || ratedPowerW <= 0) return 0;
  return heaterTargetC > 0 && currentC < heaterTargetC ? ratedPowerW : 0;
}
