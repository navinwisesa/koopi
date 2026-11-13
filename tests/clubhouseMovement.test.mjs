import test from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN, canStand, movePlayer, doorAt, doorPosition, stairAt, stairArrival } from '../lib/clubhouseMovement.ts';

test('all six doorways, including empty slots, have distinct approach areas', () => {
  for (let i = 0; i < 6; i++) assert.equal(doorAt(doorPosition(i)), i);
  assert.equal(doorAt(SPAWN), null);
  assert.equal(doorAt({ x: 220, y: 236 }), null);
});

test('former plant positions are traversable', () => {
  for (const x of [65, 895]) {
    assert.equal(canStand({ x, y: 300 }), true);
    assert.equal(canStand({ x, y: 250 }), true);
    assert.equal(canStand({ x, y: 380 }), true);
  }
});

test('the cleared corridor reaches both side walls', () => {
  const left = movePlayer({ x: 180, y: 322 }, { x: -500, y: 0 });
  assert.equal(left.x, 55);
  assert.equal(left.y, 322);
  const right = movePlayer({ x: 780, y: 322 }, { x: 500, y: 0 });
  assert.equal(right.x, 905);
});

test('right stairs advance and left stairs descend only when a floor exists', () => {
  assert.equal(stairAt({ x: 888, y: 322 }, 0, 3), 1);
  assert.equal(stairAt({ x: 72, y: 322 }, 1, 3), -1);
  assert.equal(stairAt({ x: 72, y: 322 }, 0, 3), null);
  assert.equal(stairAt({ x: 888, y: 322 }, 2, 3), null);
  assert.equal(stairAt({ x: 888, y: 322 }, 0, 1), null);
  assert.equal(stairAt({ x: 888, y: 236 }, 0, 3), null);
});

test('arrival landings are clear of both triggers so stairs cannot bounce', () => {
  assert.equal(stairAt(stairArrival(1), 1, 3), null);
  assert.equal(stairAt(stairArrival(-1), 0, 3), null);
  assert.ok(stairArrival(1).x < SPAWN.x);
  assert.ok(stairArrival(-1).x > SPAWN.x);
});

test('stair transition registers on first body contact at either inner edge', () => {
  assert.equal(stairAt({ x: 808, y: 322 }, 0, 2), 1);
  assert.equal(stairAt({ x: 807.9, y: 322 }, 0, 2), null);
  assert.equal(stairAt({ x: 152, y: 322 }, 1, 2), -1);
  assert.equal(stairAt({ x: 152.1, y: 322 }, 1, 2), null);
  // Regression: standing partly inside the right stair used to do nothing.
  assert.equal(stairAt({ x: 840, y: 322 }, 0, 2), 1);
});

test('full visible stair area registers contact from above and below', () => {
  for (const [x, floor, direction] of [[888, 0, 1], [72, 1, -1]]) {
    assert.equal(stairAt({ x, y: 263 }, floor, 2), direction);
    assert.equal(stairAt({ x, y: 262.9 }, floor, 2), null);
    assert.equal(stairAt({ x, y: 404 }, floor, 2), direction);
  }
  assert.equal(stairAt({ x: 807, y: 262 }, 0, 2), null);
});

test('walls bound movement while the central corridor remains traversable', () => {
  assert.deepEqual(movePlayer(SPAWN, { x: 0, y: -500 }), { x: 480, y: 230 });
  assert.deepEqual(movePlayer(SPAWN, { x: 0, y: 500 }), { x: 480, y: 404 });
  assert.deepEqual(movePlayer(SPAWN, { x: 30, y: 0 }), { x: 510, y: 322 });
});
