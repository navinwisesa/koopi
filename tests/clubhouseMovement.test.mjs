import test from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN, canStand, movePlayer, doorAt, doorPosition } from '../lib/clubhouseMovement.ts';

test('all six doorways, including empty slots, have distinct approach areas', () => {
  for (let i = 0; i < 6; i++) assert.equal(doorAt(doorPosition(i)), i);
  assert.equal(doorAt(SPAWN), null);
  assert.equal(doorAt({ x: 220, y: 236 }), null);
});

test('plants block feet and body on both sides of the common area', () => {
  for (const x of [65, 895]) {
    assert.equal(canStand({ x, y: 300 }), false);
    assert.equal(canStand({ x, y: 250 }), true);
    assert.equal(canStand({ x, y: 380 }), true);
  }
});

test('movement cannot tunnel through plants, even on a large frame', () => {
  const left = movePlayer({ x: 180, y: 322 }, { x: -500, y: 0 });
  assert.ok(left.x >= 109);
  assert.equal(left.y, 322);
  const right = movePlayer({ x: 780, y: 322 }, { x: 500, y: 0 });
  assert.ok(right.x <= 851);
});

test('diagonal movement slides along plants and can walk around them', () => {
  const result = movePlayer({ x: 120, y: 300 }, { x: -30, y: 80 });
  assert.ok(canStand(result));
  assert.ok(Math.abs(result.y - 380) < 0.001);
  assert.ok(result.x < 109);
});

test('walls bound movement while the central corridor remains traversable', () => {
  assert.deepEqual(movePlayer(SPAWN, { x: 0, y: -500 }), { x: 480, y: 230 });
  assert.deepEqual(movePlayer(SPAWN, { x: 0, y: 500 }), { x: 480, y: 404 });
  assert.deepEqual(movePlayer(SPAWN, { x: 30, y: 0 }), { x: 510, y: 322 });
});
