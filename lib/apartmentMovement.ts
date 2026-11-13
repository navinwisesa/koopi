import type { Point } from "./clubhouseMovement";

export type Solid = { id: string; x: number; y: number; width: number; height: number };
export const APARTMENT_SPAWN: Point = { x: 480, y: 500 };
export const APARTMENT_EXIT = { x: 438, y: 550, width: 84, height: 28 };
export const HOME_PORTAL_AREA = { x: 38, y: 274, width: 96, height: 90 };
export const APARTMENT_WALLS: Solid[] = [
  { id: "bedroom-side", x: 378, y: 40, width: 12, height: 164 },
  { id: "bedroom-door-jamb", x: 378, y: 274, width: 12, height: 26 },
  { id: "bedroom-bottom", x: 40, y: 286, width: 350, height: 14 },
  { id: "bathroom-side-top", x: 652, y: 40, width: 12, height: 126 },
  { id: "bathroom-side-bottom", x: 652, y: 226, width: 12, height: 68 },
  { id: "bathroom-bottom", x: 652, y: 280, width: 270, height: 14 },
];
export const APARTMENT_FURNITURE: Solid[] = [
  { id: "bed", x: 80, y: 92, width: 144, height: 134 },
  { id: "nightstand", x: 250, y: 98, width: 42, height: 38 },
  { id: "wardrobe", x: 76, y: 48, width: 230, height: 30 },
  { id: "desk", x: 460, y: 68, width: 130, height: 48 },
  { id: "desk-chair", x: 500, y: 138, width: 40, height: 34 },
  { id: "bookshelf", x: 540, y: 236, width: 70, height: 36 },
  { id: "shower", x: 800, y: 60, width: 100, height: 88 },
  { id: "toilet", x: 692, y: 64, width: 42, height: 52 },
  { id: "sink", x: 696, y: 244, width: 64, height: 28 },
  { id: "kitchen-counter", x: 60, y: 332, width: 250, height: 50 },
  { id: "fridge", x: 60, y: 410, width: 58, height: 66 },
  { id: "dining-table", x: 250, y: 440, width: 100, height: 90 },
  { id: "dining-chair-left", x: 212, y: 468, width: 26, height: 38 },
  { id: "dining-chair-right", x: 362, y: 468, width: 26, height: 38 },
  { id: "sofa", x: 720, y: 340, width: 156, height: 70 },
  { id: "coffee-table", x: 690, y: 450, width: 90, height: 42 },
  { id: "tv-console", x: 862, y: 456, width: 40, height: 80 },
];
const SOLIDS = [...APARTMENT_WALLS, ...APARTMENT_FURNITURE];

export const APARTMENT_DESTINATIONS = [
  { name: "Bedroom", point: { x: 310, y: 230 } },
  { name: "Bathroom", point: { x: 760, y: 190 } },
  { name: "Kitchen", point: { x: 180, y: 440 } },
  { name: "Living room", point: { x: 600, y: 440 } },
  { name: "Workspace", point: { x: 600, y: 190 } },
] as const;

function bodyTouches(point: Point, rect: { x: number; y: number; width: number; height: number }, fullBody = false): boolean {
  return point.x + (fullBody ? 18 : 14) >= rect.x && point.x - (fullBody ? 18 : 14) <= rect.x + rect.width &&
    point.y + 10 >= rect.y && point.y - (fullBody ? 56 : 12) <= rect.y + rect.height;
}

export const atHomePortal = (point: Point) => bodyTouches(point, HOME_PORTAL_AREA, true);
export const atApartmentExit = (point: Point) => bodyTouches(point, APARTMENT_EXIT);

export function canStandInApartment(point: Point): boolean {
  return point.x >= 60 && point.x <= 900 && point.y >= 70 && point.y <= 570 && !SOLIDS.some(solid => bodyTouches(point, solid));
}

export function moveInApartment(current: Point, delta: Point): Point {
  const next = { ...current };
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.y) / 3));
  for (let i = 0; i < steps; i++) {
    const horizontal = { x: next.x + delta.x / steps, y: next.y };
    if (canStandInApartment(horizontal)) next.x = horizontal.x;
    const vertical = { x: next.x, y: next.y + delta.y / steps };
    if (canStandInApartment(vertical)) next.y = vertical.y;
  }
  return next;
}

// Four-way grid paths keep taps from walking straight through a wall or bed.
// Blocked targets resolve to the nearest reachable floor tile beside them.
export function apartmentPath(start: Point, target: Point): Point[] {
  const cols = 54, rows = 33, step = 16;
  const point = (index: number): Point => ({ x: 56 + index % cols * step, y: 64 + Math.floor(index / cols) * step });
  const valid = Array.from({ length: cols * rows }, (_, index) => canStandInApartment(point(index)));
  const nearest = (origin: Point, indices: number[]) => indices.reduce((best, index) => {
    const a = point(index), b = point(best);
    return Math.hypot(a.x - origin.x, a.y - origin.y) < Math.hypot(b.x - origin.x, b.y - origin.y) ? index : best;
  });
  const available = valid.flatMap((walkable, index) => walkable ? [index] : []);
  if (!available.length) return [];
  const initial = nearest(start, available);
  const queue = [initial];
  const parents = new Map<number, number | null>([[initial, null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor], col = index % cols, row = Math.floor(index / cols);
    const neighbors = [col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1, row > 0 ? index - cols : -1, row < rows - 1 ? index + cols : -1];
    for (const next of neighbors) if (next >= 0 && valid[next] && !parents.has(next)) { parents.set(next, index); queue.push(next); }
  }
  let cursor: number | null = nearest(target, queue);
  const path: Point[] = [];
  while (cursor !== null) { path.push(point(cursor)); cursor = parents.get(cursor) ?? null; }
  return path.reverse();
}
