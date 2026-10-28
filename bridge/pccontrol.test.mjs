import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePercent, applyDelta, wifiSet } from './pccontrol.mjs'

/**
 * Pure-logic tests only — no PowerShell, no real audio/brightness/network
 * calls. In particular, wifiSet is only exercised on its synchronous
 * confirm-gate, which throws before touching the OS: a test that let it
 * proceed could actually disable this machine's Wi-Fi adapter, which is
 * exactly the blind, unconfirmed action the gate exists to prevent. The
 * "never touches Ethernet" guarantee (wifiSet only ever sources an adapter
 * name from systeminformation's wifiInterfaces(), never from parsing `netsh
 * interface show interface`) is a code-reviewed property of pccontrol.mjs,
 * not something asserted here — see the plan's note on this.
 */

test('validatePercent accepts the full 0-100 range', () => {
  assert.equal(validatePercent(0), 0)
  assert.equal(validatePercent(100), 100)
  assert.equal(validatePercent(50), 50)
  assert.equal(validatePercent('42'), 42)
  assert.equal(validatePercent(42.6), 43) // rounds
})

test('validatePercent rejects out-of-range and non-numeric input', () => {
  assert.throws(() => validatePercent(-1), /out of range/)
  assert.throws(() => validatePercent(101), /out of range/)
  assert.throws(() => validatePercent(400), /out of range/)
  assert.throws(() => validatePercent('loud'), /not a number/)
  assert.throws(() => validatePercent(NaN), /not a number/)
})

test('applyDelta clamps to 0-100 instead of over/undershooting', () => {
  assert.equal(applyDelta(50, 10), 60)
  assert.equal(applyDelta(50, -10), 40)
  assert.equal(applyDelta(95, 10), 100) // "turn it up" from near the top
  assert.equal(applyDelta(5, -10), 0) // "turn it down" from near the bottom
  assert.equal(applyDelta(50, 0), 50)
})

test('wifiSet refuses to turn Wi-Fi off without confirm:true, before any OS call', async () => {
  await assert.rejects(() => wifiSet(false, false), /needs confirmation/)
  await assert.rejects(() => wifiSet(false, undefined), /needs confirmation/)
})
