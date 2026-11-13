export type Point = { x: number; y: number };
export const SPAWN: Point = { x: 480, y: 322 };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function doorPosition(index: number): Point {
  return { x: 180 + (index % 3) * 300, y: index < 3 ? 236 : 398 };
}

// The player's feet are the ground anchor. Expanded plant bounds include the
// person's body so neither keyboard movement nor tap-to-walk clips foliage.
export function canStand(point: Point): boolean {
  if (point.x < 55 || point.x > 905 || point.y < 230 || point.y > 404) return false;
  return ![65, 895].some(x => Math.abs(point.x - x) < 44 && point.y > 258 && point.y < 365);
}

export function movePlayer(current: Point, delta: Point): Point {
  const next = { ...current };
  // Substeps prevent jumping across a collider on a slow frame. Separate axes
  // let diagonal movement slide along a solid object rather than stick to it.
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.y) / 4));
  for (let i = 0; i < steps; i++) {
    const horizontal = { x: clamp(next.x + delta.x / steps, 55, 905), y: next.y };
    if (canStand(horizontal)) next.x = horizontal.x;
    const vertical = { x: next.x, y: clamp(next.y + delta.y / steps, 230, 404) };
    if (canStand(vertical)) next.y = vertical.y;
  }
  return next;
}

export function doorAt(point: Point): number | null {
  for (let index = 0; index < 6; index++) {
    const door = doorPosition(index);
    if (Math.abs(point.x - door.x) < 25 && Math.abs(point.y - door.y) < 14) return index;
  }
  return null;
}
