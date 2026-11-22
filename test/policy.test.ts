import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctLocalChange, estimatePowerW, parseLocalChangeMode } from '../lib/adax/policy';

test('parseLocalChangeMode defaults to allow', () => {
  assert.equal(parseLocalChangeMode('lock'), 'lock');
  assert.equal(parseLocalChangeMode('limit'), 'limit');
  assert.equal(parseLocalChangeMode('allow'), 'allow');
  assert.equal(parseLocalChangeMode(undefined), 'allow');
  assert.equal(parseLocalChangeMode('nonsense'), 'allow');
});

test('allow never corrects', () => {
  assert.equal(correctLocalChange('allow', 30, 21, 21), null);
  assert.equal(correctLocalChange('allow', 0, 21, 21), null);
});

test('no correction before Homey knows a target', () => {
  assert.equal(correctLocalChange('lock', 30, null, null), null);
  assert.equal(correctLocalChange('limit', 30, null, null), null);
});

test('lock reverts every change, including on/off', () => {
  assert.equal(correctLocalChange('lock', 21, 21, 21), null);
  assert.equal(correctLocalChange('lock', 22, 21, 21), 21);
  assert.equal(correctLocalChange('lock', 0, 21, 21), 21); // switched off on the heater
  assert.equal(correctLocalChange('lock', 21, 0, 21), 0); // switched on while Homey has it off
  assert.equal(correctLocalChange('lock', 0, 0, 21), null);
});

test('limit allows ±3 °C and on/off, clamps larger changes', () => {
  assert.equal(correctLocalChange('limit', 21, 21, 21), null);
  assert.equal(correctLocalChange('limit', 24, 21, 21), null);
  assert.equal(correctLocalChange('limit', 18, 21, 21), null);
  assert.equal(correctLocalChange('limit', 25, 21, 21), 24);
  assert.equal(correctLocalChange('limit', 10, 21, 21), 18);
  assert.equal(correctLocalChange('limit', 0, 21, 21), null); // off is allowed
  // Homey has it off: switching on locally is allowed within ±3 of last Homey temperature
  assert.equal(correctLocalChange('limit', 22, 0, 21), null);
  assert.equal(correctLocalChange('limit', 30, 0, 21), 24);
  // limits are clamped to the heater range 5–35
  assert.equal(correctLocalChange('limit', 5, 6, 6), null);
  assert.equal(correctLocalChange('limit', 35, 34, 34), null);
});

test('estimatePowerW: rated power only while heating', () => {
  assert.equal(estimatePowerW(800, 22, 20.5), 800);
  assert.equal(estimatePowerW(800, 22, 22), 0);
  assert.equal(estimatePowerW(800, 22, 23), 0);
  assert.equal(estimatePowerW(800, 0, 15), 0); // off
  assert.equal(estimatePowerW(0, 22, 15), 0); // not configured
  assert.equal(estimatePowerW(Number.NaN, 22, 15), 0);
});
