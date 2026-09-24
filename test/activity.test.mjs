// The browser modules are ES modules, so this test file is one too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_LEVELS, LEVEL_STARTS, activityLevel, daysIdle, isInactive } from '../public/js/activity.js';

const DAY_MS = 86_400_000;

test('pins the policy: two weeks, two months, half a year', () => {
  // The other tests take their boundaries from LEVEL_STARTS, so only this one
  // notices when the numbers themselves change.
  assert.deepEqual(LEVEL_STARTS, { recent: 14, idle: 60, dormant: 180 });
});

test('treats missing or non-finite idle times as unknown', () => {
  for (const days of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(activityLevel(days), 'unknown', `activityLevel(${days})`);
  }
});

test('counts anything under two weeks as active', () => {
  assert.equal(activityLevel(0), 'active');
  assert.equal(activityLevel(13.99), 'active');
});

test('starts each level exactly at its threshold', () => {
  assert.equal(activityLevel(LEVEL_STARTS.recent - 0.01), 'active');
  assert.equal(activityLevel(LEVEL_STARTS.recent), 'recent');
  assert.equal(activityLevel(LEVEL_STARTS.idle - 0.01), 'recent');
  assert.equal(activityLevel(LEVEL_STARTS.idle), 'idle');
  assert.equal(activityLevel(LEVEL_STARTS.dormant - 0.01), 'idle');
  assert.equal(activityLevel(LEVEL_STARTS.dormant), 'dormant');
  assert.equal(activityLevel(10_000), 'dormant');
});

test('only returns levels the dot colors know about', () => {
  for (const days of [null, NaN, 0, 5, 14, 30, 60, 100, 180, 1e9]) {
    assert.ok(ACTIVITY_LEVELS.includes(activityLevel(days)), `activityLevel(${days})`);
  }
});

test('measures days since a timestamp and returns null without one', () => {
  const now = 1_700_000_000_000;
  assert.equal(daysIdle(0), null);
  assert.equal(daysIdle(null), null);
  assert.equal(daysIdle(now - 3 * DAY_MS, now), 3);
  assert.equal(daysIdle(now - DAY_MS / 2, now), 0.5);
  // A clock that went backwards must not produce negative idle time.
  assert.equal(daysIdle(now + DAY_MS, now), 0);
});

test('flags projects untouched for two months or more as inactive', () => {
  const now = Date.now();
  assert.equal(isInactive(now - 90 * DAY_MS), true);
  assert.equal(isInactive(now - 400 * DAY_MS), true);
  assert.equal(isInactive(now - 3 * DAY_MS), false);
  assert.equal(isInactive(0), false);
});
