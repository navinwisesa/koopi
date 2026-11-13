export type Point = { x: number; y: number };
export const SPAWN: Point = { x: 480, y: 322 };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function doorPosition(index: number): Point {
  return { x: 180 + (index % 3) * 300, y: index < 3 ? 236 : 398 };
}

export function canStand(point: Point): boolean {
  return point.x >= 55 && point.x <= 905 && point.y >= 230 && point.y <= 404;
}

export function movePlayer(current: Point, delta: Point): Point {
  return { x: clamp(current.x + delta.x, 55, 905), y: clamp(current.y + delta.y, 230, 404) };
}

export type StairDirection = -1 | 1;
export function stairAt(point: Point, floor: number, floorCount: number): StairDirection | null {
  if (point.y < 285 || point.y > 355) return null;
  if (point.x <= 94 && floor > 0) return -1;
  if (point.x >= 866 && floor < floorCount - 1) return 1;
  return null;
}

// Land clear of the opposite staircase so a transition cannot bounce back.
export function stairArrival(direction: StairDirection): Point {
  return { x: direction === 1 ? 155 : 805, y: SPAWN.y };
}

export function doorAt(point: Point): number | null {
  for (let index = 0; index < 6; index++) {
    const door = doorPosition(index);
    if (Math.abs(point.x - door.x) < 25 && Math.abs(point.y - door.y) < 14) return index;
  }
  return null;
}
