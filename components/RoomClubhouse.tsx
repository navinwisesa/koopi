"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, DoorOpen } from "lucide-react";
import type { RoomView } from "@/components/DashboardRooms";
import styles from "./RoomClubhouse.module.css";

type Point = { x: number; y: number };
const SPAWN = { x: 480, y: 322 };
const MOVEMENT: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 },
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function doorPosition(index: number): Point {
  return { x: 180 + (index % 3) * 300, y: index < 3 ? 236 : 398 };
}

function Plant({ x, y }: Point) {
  return <g transform={`translate(${x} ${y})`}>
    <ellipse cy="9" rx="16" ry="9" fill="#121a19" opacity=".4" />
    <rect x="-10" y="-5" width="20" height="21" rx="5" fill="#bc9b78" />
    <path d="M0 0C-34-5-22-31-4-15C-13-44 17-42 9-15C31-32 36-4 0 0" fill="#538977" stroke="#2c554b" strokeWidth="3" />
  </g>;
}

export default function RoomClubhouse({ rooms, displayName, onCreate, active }: {
  rooms: RoomView[]; displayName: string; onCreate: () => void; active: boolean;
}) {
  const [floor, setFloor] = useState(0);
  const [position, setPosition] = useState<Point>(SPAWN);
  const [walking, setWalking] = useState(false);
  const [facing, setFacing] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const map = useRef<SVGSVGElement>(null);
  const keys = useRef(new Set<string>());
  const destination = useRef<Point | null>(null);
  const positionRef = useRef<Point>(SPAWN);
  const floorCount = Math.max(1, Math.ceil(rooms.length / 6));
  const currentFloor = Math.min(floor, floorCount - 1);
  const visibleRooms = rooms.slice(currentFloor * 6, currentFloor * 6 + 6);
  const nearby = visibleRooms.findIndex((_, index) => {
    const door = doorPosition(index);
    return Math.hypot(door.x - position.x, door.y - position.y) < 64;
  });
  const nearbyRoom = visibleRooms[nearby];

  const stop = useCallback(() => {
    keys.current.clear();
    destination.current = null;
    setWalking(false);
  }, []);

  useEffect(() => {
    if (!active) { stop(); return; }
    let frame: number;
    let previous = 0;
    function tick(time: number) {
      const dt = previous ? Math.min((time - previous) / 1000, .04) : 0;
      previous = time;
      let dx = 0, dy = 0;
      keys.current.forEach(key => { dx += MOVEMENT[key]?.x ?? 0; dy += MOVEMENT[key]?.y ?? 0; });
      const current = positionRef.current;
      if (!dx && !dy && destination.current) {
        dx = destination.current.x - current.x;
        dy = destination.current.y - current.y;
        if (Math.hypot(dx, dy) < 4) { destination.current = null; dx = 0; dy = 0; }
      }
      const distance = Math.hypot(dx, dy);
      if (distance) {
        const step = Math.min(190 * dt, destination.current ? distance : Infinity);
        const next = { x: clamp(current.x + dx / distance * step, 55, 905), y: clamp(current.y + dy / distance * step, 230, 404) };
        positionRef.current = next;
        setPosition(next);
        if (dx) setFacing(dx < 0 ? -1 : 1);
        setWalking(next.x !== current.x || next.y !== current.y);
        const container = viewport.current;
        if (container && map.current) {
          const screenX = next.x / 960 * map.current.clientWidth;
          if (screenX < container.scrollLeft + 80 || screenX > container.scrollLeft + container.clientWidth - 80) {
            container.scrollLeft = screenX - container.clientWidth / 2;
          }
        }
      } else { setWalking(false); }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); stop(); };
  }, [active, stop]);

  function changeFloor(next: number) {
    stop();
    setFloor(clamp(next, 0, floorCount - 1));
    positionRef.current = SPAWN;
    setPosition(SPAWN);
  }

  function walkTo(point: Point) {
    if (!active) return;
    keys.current.clear();
    destination.current = { x: clamp(point.x, 55, 905), y: clamp(point.y, 230, 404) };
    root.current?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.clubhouse}>
      <div className={styles.heading}>
        <div><h3 className="font-display text-xl font-semibold">The clubhouse</h3><p id="clubhouse-help" className="mt-1 text-sm text-muted">Walk to a door. Make something together.</p></div>
        <span className={styles.floorLabel}>Floor {currentFloor + 1} / {floorCount}</span>
      </div>
      <div ref={root} className={styles.playArea} tabIndex={0} role="group" aria-label="Walkable clubhouse" aria-describedby="clubhouse-help clubhouse-controls"
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) stop(); }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || !active || event.ctrlKey || event.metaKey || event.altKey) return;
          const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
          if (MOVEMENT[key]) { event.preventDefault(); destination.current = null; keys.current.add(key); }
          if (event.key === "Enter" && nearbyRoom) { event.preventDefault(); document.getElementById(`clubhouse-enter-${nearbyRoom.id}`)?.click(); }
        }}
        onKeyUp={event => { keys.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key); }}>
        <div ref={viewport} className={styles.viewport}>
          <svg ref={map} viewBox="0 0 960 620" className={styles.map} role="img" aria-label={`Clubhouse floor ${currentFloor + 1}, ${visibleRooms.length} room doors`}
            onClick={event => {
              const svg = map.current;
              if (!svg) return;
              const bounds = svg.getBoundingClientRect();
              walkTo({ x: (event.clientX - bounds.left) / bounds.width * 960, y: (event.clientY - bounds.top) / bounds.height * 620 });
            }}>
            <defs>
              <pattern id="clubhouse-tile" width="60" height="40" patternUnits="userSpaceOnUse"><rect width="60" height="40" fill="#30373c" /><path d="M60 0H0V40" fill="none" stroke="#394147" strokeWidth="1" /></pattern>
              <pattern id="clubhouse-wood" width="60" height="18" patternUnits="userSpaceOnUse"><rect width="60" height="18" fill="#665c54" /><path d="M60 0H0V18" fill="none" stroke="#776c61" strokeWidth="1" /></pattern>
            </defs>
            <rect width="960" height="620" fill="#1c2328" />
            <rect x="24" y="30" width="912" height="556" rx="12" fill="url(#clubhouse-tile)" stroke="#11171b" strokeWidth="10" />
            {Array.from({ length: 6 }, (_, index) => {
              const room = visibleRooms[index];
              const x = 42 + index % 3 * 300;
              const top = index < 3;
              const y = top ? 48 : 432;
              const door = doorPosition(index);
              return <g key={room?.id ?? `empty-${index}`}>
                <rect x={x} y={y + 6} width="276" height="140" rx="4" fill="#11171b" opacity=".4" />
                <rect x={x} y={y} width="276" height="134" rx="4" fill="url(#clubhouse-wood)" stroke="#171e23" strokeWidth="8" />
                {room ? <>
                  <rect x={x + 28} y={y + 26} width="80" height="42" rx="6" fill="#303940" stroke="#95a4a8" strokeWidth="2" />
                  <rect x={x + 40} y={y + 32} width="30" height="24" rx="2" fill="#9aabff" />
                  <path d={`M${x + 46} ${y + 62}h40`} stroke="#c2b3a0" strokeWidth="3" />
                  <rect x={x + 54} y={y + 72} width="28" height="20" rx="7" fill="#708c86" stroke="#304e4b" strokeWidth="4" />
                  <Plant x={x + 241} y={y + 44} />
                  <rect x={door.x - 34} y={top ? 178 : 425} width="68" height="11" rx="3" fill="#9aabff" />
                  <rect x={door.x - 34} y={top ? 190 : 415} width="68" height="7" fill="#161e24" />
                  <text x={x + 135} y={y + 52} fill="#f2f2f0" fontSize="12">{room.members.length} {room.members.length === 1 ? "member" : "members"}</text>
                  <text x={x + 135} y={y + 72} fill="#e2d4c8" fontSize="12">{room.visibility}</text>
                  <g className={styles.door} role="button" tabIndex={-1} aria-label={`Walk to ${room.name}`} onClick={event => { event.stopPropagation(); walkTo(door); }}>
                    <title>{room.name} — walk to this door</title>
                    <rect x={door.x - 123} y={y + 100} width="246" height="32" rx="6" fill={nearby === index ? "#0c29e8" : "#202a33"} stroke={nearby === index ? "#9aabff" : "#53616d"} />
                    <text x={door.x} y={y + 121} textAnchor="middle" fill="#f2f2f0" fontSize="15" fontWeight="600">{room.name.length > 25 ? `${room.name.slice(0, 24)}…` : room.name}</text>
                  </g>
                </> : <>
                  <rect x={x + 86} y={y + 38} width="104" height="52" rx="6" fill="#514b46" stroke="#8a7c6e" strokeDasharray="4 5" />
                  <text x={x + 138} y={y + 68} textAnchor="middle" fill="#dbcdc0" fontSize="12">Room to grow</text>
                </>}
              </g>;
            })}
            <rect x="362" y="272" width="236" height="90" rx="12" fill="#233456" stroke="#536797" strokeWidth="2" />
            <rect x="370" y="280" width="220" height="74" rx="8" fill="none" stroke="#536797" strokeDasharray="3 4" />
            <text x="480" y="310" textAnchor="middle" fill="#aebeff" fontSize="25" fontWeight="700" letterSpacing="5">KOOPI</text>
            <text x="480" y="338" textAnchor="middle" fill="#c0c9df" fontSize="12">GOOD THINGS START HERE</text>
            <Plant x={65} y={300} /><Plant x={895} y={300} />
            <rect x="70" y="558" width="116" height="16" rx="5" fill="#b39b81" />
            <rect x="774" y="558" width="116" height="16" rx="5" fill="#b39b81" />
            <text x="480" y="584" textAnchor="middle" fill="#b4c2cc" fontSize="12" letterSpacing="2">YOUR NEXT IDEA IS A DOOR AWAY</text>
            <g transform={`translate(${position.x} ${position.y})`} data-testid="clubhouse-player" aria-hidden="true">
              <ellipse cy="8" rx="17" ry="7" fill="#10171e" opacity=".5" />
              <g transform={`scale(${facing} 1)`}>
                <g className={walking ? styles.walking : undefined}>
                  <rect className={styles.leftFoot} x="-10" y="-1" width="8" height="12" rx="3" fill="#dce5ee" />
                  <rect className={styles.rightFoot} x="3" y="-1" width="8" height="12" rx="3" fill="#dce5ee" />
                </g>
                <rect x="-14" y="-25" width="28" height="29" rx="9" fill="#5774ff" stroke="#a3b4ff" strokeWidth="2" />
                <rect x="-18" y="-19" width="7" height="17" rx="3" fill="#e4b893" />
                <rect x="11" y="-19" width="7" height="17" rx="3" fill="#e4b893" />
                <rect x="-12" y="-49" width="25" height="27" rx="10" fill="#e4b893" />
                <path d="M-13-34v-10q0-13 14-12q15 0 14 18L4-42l-17 8" fill="#302b35" />
                <rect x="4" y="-37" width="3" height="4" rx="1" fill="#302b35" />
              </g>
              {nearby < 0 && <>
                <rect x="-54" y="-76" width="108" height="21" rx="10" fill="#111b2b" stroke="#7c96ff" />
                <text y="-61" textAnchor="middle" fill="#e4eaff" fontSize="12">{displayName.length > 11 ? `${displayName.slice(0, 10)}…` : displayName} (you)</text>
              </>}
            </g>
          </svg>
        </div>
      </div>
      <div className={styles.toolbar}>
        <p id="clubhouse-controls" className="text-sm text-muted"><span className="text-foreground">WASD / arrows</span> to walk · tap the floor to move<br /><span className="text-xs">Focus the map to use keys. On phones, swipe to explore.</span></p>
        <div className={styles.entry} aria-live="polite">
          {nearbyRoom ? <Link id={`clubhouse-enter-${nearbyRoom.id}`} href={`/room/${nearbyRoom.id}`} className={styles.enter}><DoorOpen size={17} aria-hidden="true" /><span className="truncate">Enter {nearbyRoom.name}</span><kbd>↵</kbd></Link>
            : rooms.length === 0 ? <button type="button" onClick={onCreate} className={styles.enter}>Create your first room</button>
              : <span className="text-sm text-muted">Approach a door to enter</span>}
        </div>
      </div>
      <div className={styles.bottomBar}>
        <div className={styles.dpad} role="group" aria-label="Walk controls">
          {([{ key: "ArrowLeft", Icon: ArrowLeft, label: "Walk left" }, { key: "ArrowUp", Icon: ArrowUp, label: "Walk up" }, { key: "ArrowDown", Icon: ArrowDown, label: "Walk down" }, { key: "ArrowRight", Icon: ArrowRight, label: "Walk right" }]).map(({ key, Icon, label }) => (
            <button key={key} type="button" aria-label={label} onPointerDown={event => { if (!active) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); destination.current = null; keys.current.add(key); }}
              onPointerUp={() => keys.current.delete(key)} onPointerCancel={stop} onLostPointerCapture={() => keys.current.delete(key)}
              onClick={event => { if (event.detail === 0) { const delta = MOVEMENT[key]; walkTo({ x: position.x + delta.x * 45, y: position.y + delta.y * 45 }); } }}><Icon size={18} /></button>
          ))}
        </div>
        {floorCount > 1 && <div className={styles.pagination}><button type="button" aria-label="Previous floor" disabled={currentFloor === 0} onClick={() => changeFloor(currentFloor - 1)}><ChevronLeft size={18} /></button><span>Floor {currentFloor + 1}</span><button type="button" aria-label="Next floor" disabled={currentFloor === floorCount - 1} onClick={() => changeFloor(currentFloor + 1)}><ChevronRight size={18} /></button></div>}
      </div>
      {!!rooms.length && <details className={styles.directory}><summary>Room directory · jump straight in</summary><ul>{visibleRooms.map(room => <li key={room.id}><Link href={`/room/${room.id}`}>{room.name}<ArrowRight size={15} aria-hidden="true" /></Link></li>)}</ul></details>}
    </div>
  );
}
