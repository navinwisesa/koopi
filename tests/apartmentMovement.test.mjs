import test from 'node:test';
import assert from 'node:assert/strict';
import { APARTMENT_SPAWN, APARTMENT_DESTINATIONS, APARTMENT_FURNITURE, APARTMENT_WALLS, apartmentPath, atApartmentExit, atHomePortal, canStandInApartment, moveInApartment } from '../lib/apartmentMovement.ts';

test('every apartment destination is reachable through actual doorways', () => {
  for (const start of [APARTMENT_SPAWN, ...APARTMENT_DESTINATIONS.map(item => item.point)]) {
    for (const { name, point: target } of APARTMENT_DESTINATIONS) {
      const path = apartmentPath(start, target);
      assert.ok(path.length, name);
      let current = start;
      for (const next of path) {
        assert.ok(canStandInApartment(next), name);
        current = moveInApartment(current, { x: next.x - current.x, y: next.y - current.y });
        assert.ok(Math.hypot(current.x - next.x, current.y - next.y) < .01, `${name}: route blocked`);
      }
      assert.ok(Math.hypot(current.x - target.x, current.y - target.y) < 20, `${name}: destination unreachable`);
    }
  }
});

test('walls block large keyboard steps but door openings remain traversable', () => {
  assert.ok(moveInApartment({ x: 420, y: 160 }, { x: -200, y: 0 }).x > 404);
  assert.ok(moveInApartment({ x: 420, y: 240 }, { x: -100, y: 0 }).x < 350);
  assert.ok(moveInApartment({ x: 600, y: 130 }, { x: 200, y: 0 }).x < 638);
  assert.ok(moveInApartment({ x: 600, y: 192 }, { x: 160, y: 0 }).x > 745);
});

test('all visible walls and furniture are solid; beds cannot be tunneled through', () => {
  for (const rect of [...APARTMENT_FURNITURE, ...APARTMENT_WALLS]) {
    assert.equal(canStandInApartment({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }), false, rect.id);
  }
  assert.ok(moveInApartment({ x: 310, y: 180 }, { x: -500, y: 0 }).x > 238);
});

test('taps on solid furniture route to reachable floor beside it', () => {
  const path = apartmentPath(APARTMENT_SPAWN, { x: 150, y: 160 });
  assert.ok(path.length);
  assert.ok(path.every(canStandInApartment));
  assert.ok(canStandInApartment(path.at(-1)));
});

test('apartment portal and exit are distinct from safe arrival positions', () => {
  assert.ok(atHomePortal({ x: 152, y: 322 }));
  assert.equal(atHomePortal({ x: 155, y: 322 }), false);
  assert.equal(atApartmentExit(APARTMENT_SPAWN), false);
  assert.ok(atApartmentExit({ x: 480, y: 540 }));
  const path = apartmentPath(APARTMENT_SPAWN, { x: 480, y: 562 });
  assert.ok(path.some(atApartmentExit));
});
