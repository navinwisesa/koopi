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
export const STAIR_AREAS = {
  left: { x: 38, y: 274, width: 96, height: 90 },
  right: { x: 826, y: 274, width: 96, height: 90 },
} as const;

export function stairAt(point: Point, floor: number, floorCount: number): StairDirection | null {
  // Match the character's visible body, not just the feet anchor. The name
  // bubble is decoration and does not participate in physical contact.
  const touches = (area: typeof STAIR_AREAS.left | typeof STAIR_AREAS.right) =>
    point.x + 18 >= area.x && point.x - 18 <= area.x + area.width &&
    point.y + 11 >= area.y && point.y - 56 <= area.y + area.height;
  if (floor > 0 && touches(STAIR_AREAS.left)) return -1;
  if (floor < floorCount - 1 && touches(STAIR_AREAS.right)) return 1;
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
