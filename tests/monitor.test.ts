// Percent calculation and the threshold decision (src/monitor.ts)
import { expect, test } from 'claude-code/testing'
import { percentOf, shouldPrompt } from '../src/monitor'

test('percentOf prefers the engine percent', () => {
  expect(percentOf({ tokens: 32_737, window: 1_000_000, percent: 3 })).toBe(3)
  // Even when it would round differently from the fallback
  expect(percentOf({ tokens: 399_999, window: 1_000_000, percent: 40 })).toBe(40)
})

test('percentOf falls back to floor(tokens / window * 100)', () => {
  expect(percentOf({ tokens: 399_999, window: 1_000_000 })).toBe(39)
  expect(percentOf({ tokens: 400_000, window: 1_000_000 })).toBe(40)
  expect(percentOf({ tokens: 410_000, window: 1_000_000 })).toBe(41)
  // 200k window
  expect(percentOf({ tokens: 79_999, window: 200_000 })).toBe(39)
  expect(percentOf({ tokens: 80_000, window: 200_000 })).toBe(40)
  expect(percentOf({ tokens: 82_000, window: 200_000 })).toBe(41)
})

test('percentOf is undefined when usage is not known yet', () => {
  // Session start and right after /clear: no tokens and no percent
  expect(percentOf({ window: 1_000_000 })).toBeUndefined()
  expect(percentOf({ tokens: 1000, window: 0 })).toBeUndefined()
  expect(percentOf({ tokens: Number.NaN, window: 1_000_000 })).toBeUndefined()
})

test('shouldPrompt at threshold 40: 39 no, 40 yes, 41 yes; unknown no', () => {
  expect(shouldPrompt(39, 40)).toBe(false)
  expect(shouldPrompt(40, 40)).toBe(true)
  expect(shouldPrompt(41, 40)).toBe(true)
  expect(shouldPrompt(undefined, 40)).toBe(false)
})

test('shouldPrompt with other thresholds', () => {
  expect(shouldPrompt(9, 10)).toBe(false)
  expect(shouldPrompt(10, 10)).toBe(true)
  expect(shouldPrompt(89, 90)).toBe(false)
  expect(shouldPrompt(90, 90)).toBe(true)
})

test('shouldPrompt respects the snooze mark', () => {
  expect(shouldPrompt(45, 40, 50)).toBe(false)
  expect(shouldPrompt(50, 40, 50)).toBe(true)
  expect(shouldPrompt(55, 40, 50)).toBe(true)
})
