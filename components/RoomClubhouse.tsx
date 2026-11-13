"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, DoorOpen, Pencil, X } from "lucide-react";
import type { RoomView } from "@/components/DashboardRooms";
import { type Point, type StairDirection, SPAWN, STAIR_AREAS, clamp, doorPosition, movePlayer, doorAt, stairAt, stairArrival } from "@/lib/clubhouseMovement";
import styles from "./RoomClubhouse.module.css";

const MOVEMENT: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 },
};
const DEFAULT_CARPET = { headline: "KOOPI", caption: "what do you wanna make today?" };
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]');

export default function RoomClubhouse({ rooms, userId, displayName, onCreate, active }: {
  rooms: RoomView[]; userId: string; displayName: string; onCreate: () => void; active: boolean;
}) {
  const router = useRouter();
  const [floor, setFloor] = useState(0);
  const [position, setPosition] = useState<Point>(SPAWN);
  const [walking, setWalking] = useState(false);
  const [facing, setFacing] = useState(1);
  const [prompt, setPrompt] = useState<number | null>(null);
  const promptRef = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [carpet, setCarpet] = useState(DEFAULT_CARPET);
  const [draft, setDraft] = useState(DEFAULT_CARPET);
  const [storageError, setStorageError] = useState("");
  const editor = useRef<HTMLDialogElement>(null);
  const carpetButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const map = useRef<SVGSVGElement>(null);
  const keys = useRef(new Set<string>());
  const destination = useRef<Point | null>(null);
  const positionRef = useRef<Point>(SPAWN);
  const floorCount = Math.floor(rooms.length / 6) + 1;
  const currentFloor = Math.min(floor, floorCount - 1);
  const visibleRooms = useMemo(() => rooms.slice(currentFloor * 6, currentFloor * 6 + 6), [rooms, currentFloor]);
  const nearby = prompt ?? -1;
  const promptedRoom = prompt === null ? undefined : visibleRooms[prompt];
  const topDoor = prompt !== null && prompt < 3;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`koopi:carpet:${userId}`) ?? "null");
      if (saved && typeof saved.headline === "string" && typeof saved.caption === "string") {
        setCarpet({ headline: saved.headline.slice(0, 22), caption: saved.caption.slice(0, 46) });
      }
    } catch { /* Default carpet remains available without storage. */ }
  }, [userId]);

  const stop = useCallback(() => {
    keys.current.clear();
    destination.current = null;
    setWalking(false);
  }, []);

  const takeStairs = useCallback((direction: StairDirection) => {
    if (!active || editing || promptRef.current !== null) return;
    const nextFloor = currentFloor + direction;
    if (nextFloor < 0 || nextFloor >= floorCount) return;
    stop();
    setFloor(nextFloor);
    const landing = stairArrival(direction);
    positionRef.current = landing;
    setPosition(landing);
    setFacing(direction);
    const container = viewport.current;
    if (container && map.current) container.scrollLeft = landing.x / 960 * map.current.clientWidth - container.clientWidth / 2;
  }, [active, editing, currentFloor, floorCount, stop]);

  const leaveDoor = useCallback(() => {
    const index = promptRef.current;
    if (index === null) return;
    stop();
    const point = { x: doorPosition(index).x, y: SPAWN.y };
    positionRef.current = point;
    setPosition(point);
    promptRef.current = null;
    setPrompt(null);
  }, [stop]);

  const enterDoor = useCallback(() => {
    const index = promptRef.current;
    if (index === null) return;
    stop();
    const room = visibleRooms[index];
    if (room) router.push(`/room/${room.id}`);
    else { leaveDoor(); onCreate(); }
  }, [visibleRooms, router, stop, leaveDoor, onCreate]);

  function openEditor() {
    if (!active) return;
    stop();
    setDraft(carpet);
    setStorageError("");
    setEditing(true);
    editor.current?.showModal();
  }

  function closeEditor() {
    editor.current?.close();
    setEditing(false);
    carpetButton.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!active || editing) { stop(); return; }
    let frame: number;
    let previous = 0;
    function tick(time: number) {
      const dt = previous ? Math.min((time - previous) / 1000, .04) : 0;
      previous = time;
      if (promptRef.current !== null) { frame = requestAnimationFrame(tick); return; }
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
        let next = movePlayer(current, { x: dx / distance * step, y: dy / distance * step });
        const stairs = stairAt(next, currentFloor, floorCount);
        if (stairs !== null) {
          takeStairs(stairs);
          frame = requestAnimationFrame(tick);
          return;
        }
        if (next.x === current.x && next.y === current.y) destination.current = null;
        const door = doorAt(next);
        if (door !== null) {
          next = doorPosition(door);
          stop();
          promptRef.current = door;
          setPrompt(door);
          root.current?.focus({ preventScroll: true });
        }
        positionRef.current = next;
        setPosition(next);
        if (dx) setFacing(dx < 0 ? -1 : 1);
        setWalking(door === null && (next.x !== current.x || next.y !== current.y));
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
    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const index = promptRef.current;
      if (index !== null) {
        const confirm = index < 3 ? ["w", "ArrowUp"] : ["s", "ArrowDown"];
        const cancel = index < 3 ? ["s", "ArrowDown"] : ["w", "ArrowUp"];
        const control = event.target instanceof Element && !!event.target.closest("button, a, summary");
        if (MOVEMENT[key] || key === "Escape" || (key === "Enter" && !control)) {
          event.preventDefault();
          if (event.repeat) return;
          if (confirm.includes(key) || key === "Enter") enterDoor();
          else if (cancel.includes(key) || key === "Escape") leaveDoor();
        }
        return;
      }
      if (MOVEMENT[key]) { event.preventDefault(); destination.current = null; keys.current.add(key); }
    }
    function onKeyUp(event: KeyboardEvent) { keys.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key); }
    function onFocus(event: FocusEvent) { if (isTyping(event.target)) stop(); }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp); document.removeEventListener("focusin", onFocus); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); stop(); };
  }, [active, editing, stop, enterDoor, leaveDoor, currentFloor, floorCount, takeStairs]);

  function walkTo(point: Point) {
    if (!active || editing || promptRef.current !== null) return;
    keys.current.clear();
    destination.current = { x: clamp(point.x, 55, 905), y: clamp(point.y, 230, 404) };
    root.current?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.clubhouse}>
      <div className={styles.heading}>
        <div><h3 className="font-display text-xl font-semibold">The clubhouse</h3><p id="clubhouse-help" className="mt-1 text-sm text-muted">Walk to a door. Make something together.</p></div>
        <span className={styles.floorLabel} role="status">Floor {currentFloor + 1} / {floorCount}</span>
      </div>
      <div ref={root} className={styles.playArea} tabIndex={0} role="group" aria-label="Walkable clubhouse" aria-describedby="clubhouse-help clubhouse-controls">
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
                  <g className={styles.door} role="button" tabIndex={-1} aria-label={`Walk to empty room ${index + 1}`} onClick={event => { event.stopPropagation(); walkTo(door); }}>
                    <title>Create a room here</title>
                    <rect x={door.x - 123} y={y + 100} width="246" height="32" rx="6" fill={nearby === index ? "#0c29e8" : "#202a33"} stroke="#9aabff" strokeDasharray="4 4" />
                    <text x={door.x} y={y + 121} textAnchor="middle" fill="#f2f2f0" fontSize="15">Create a room</text>
                    <rect x={door.x - 34} y={top ? 178 : 425} width="68" height="11" rx="3" fill="#9aabff" />
                    <rect x={door.x - 34} y={top ? 190 : 415} width="68" height="7" fill="#161e24" />
                  </g>
                </>}
              </g>;
            })}
            <g className={styles.carpet} onClick={event => { event.stopPropagation(); openEditor(); }}>
            <title>Customize your carpet</title>
            <rect x="362" y="272" width="236" height="90" rx="12" fill="#233456" stroke="#536797" strokeWidth="2" />
            <rect x="370" y="280" width="220" height="74" rx="8" fill="none" stroke="#536797" strokeDasharray="3 4" />
            <text x="480" y="310" textAnchor="middle" fill="#aebeff" fontSize={carpet.headline.length > 13 ? "15" : "25"} fontWeight="700" letterSpacing={carpet.headline.length > 10 ? "0" : "3"} textLength={carpet.headline.length > 8 ? 200 : undefined} lengthAdjust="spacingAndGlyphs">{carpet.headline}</text>
            <text x="480" y="338" textAnchor="middle" fill="#c0c9df" fontSize="12" textLength={carpet.caption.length > 18 ? 204 : undefined} lengthAdjust="spacingAndGlyphs">{carpet.caption}</text>
            </g>
            {([-1, 1] as const).map(direction => {
              const right = direction === 1;
              const area = right ? STAIR_AREAS.right : STAIR_AREAS.left;
              const x = area.x;
              const available = right ? currentFloor < floorCount - 1 : currentFloor > 0;
              if (!available) return null;
              const label = right ? "Next floor" : "Previous floor";
              return <g key={direction} className={styles.stairs} aria-label={`Walk to ${label.toLowerCase()} staircase`} role="button" tabIndex={-1}
                onClick={event => { event.stopPropagation(); walkTo({ x: right ? 888 : 72, y: SPAWN.y }); }}>
                <title>{label} — walk onto the stairs</title>
                <rect {...area} rx="5" fill="#141e29" stroke="#9aabff" strokeWidth="2" />
                <g>
                  {Array.from({ length: 7 }, (_, step) => <g key={step}>
                    <rect x={x + 7 + step * 12} y={291 - (right ? step : 6 - step) * 2} width="12" height={52 + (right ? step : 6 - step) * 2} fill={step % 2 ? "#56657a" : "#667992"} stroke="#1c2a3c" strokeWidth="1" />
                    <path d={`M${x + 8 + step * 12} ${292 - (right ? step : 6 - step) * 2}v${50 + (right ? step : 6 - step) * 2}`} stroke="#b0bed2" strokeWidth="1" />
                  </g>)}
                  <path d={right ? `M${x + 26} 312h44m-9-9 9 9-9 9` : `M${x + 70} 312H${x + 26}m9-9-9 9 9 9`} fill="none" stroke="#f2f2f0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </g>
                <text x={x + 48} y="385" textAnchor="middle" fill="#c1cdff" fontSize="12">{label}</text>
              </g>;
            })}
            <rect x="70" y="558" width="116" height="16" rx="5" fill="#b39b81" />
            <rect x="774" y="558" width="116" height="16" rx="5" fill="#b39b81" />
            <text x="480" y="584" textAnchor="middle" fill="#b4c2cc" fontSize="12" letterSpacing="2">YOUR NEXT IDEA IS A DOOR AWAY</text>
            <g transform={`translate(${position.x} ${position.y})`} data-testid="clubhouse-player" aria-hidden="true" pointerEvents="none">
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
        {prompt !== null && <div className={styles.dialogue} data-side={topDoor ? "top" : "bottom"} role="group" aria-label="Door invitation">
          <div className={styles.speaker} aria-hidden="true">K</div>
          <div className={styles.dialogueBody}>
            <p className={styles.speakerName}>Koopi</p>
            <p className={styles.dialogueText}>{promptedRoom ? <>Ready to head into <strong>{promptedRoom.name}</strong>?</> : "An empty room, a fresh start. Want to make it yours?"}</p>
            <p className={styles.keyHint}><kbd>{topDoor ? "W / ↑" : "S / ↓"}</kbd> or <kbd>Enter</kbd> to {promptedRoom ? "come in" : "create"} · <kbd>{topDoor ? "S / ↓" : "W / ↑"}</kbd> to go back</p>
            <div className={styles.dialogueActions}>
              <button type="button" onClick={enterDoor} className={styles.enter}><DoorOpen size={16} />{promptedRoom ? "Come in" : "Create a room"}</button>
              <button type="button" onClick={leaveDoor} className={styles.secondary}>Back to common area</button>
            </div>
          </div>
        </div>}
      </div>
      <div className={styles.toolbar}>
        <p id="clubhouse-controls" className="text-sm text-muted"><span className="text-foreground">WASD / arrows</span> to walk · tap the floor to move<br /><span className="text-xs">Right stairs: next floor. Left stairs: previous floor. Tap the carpet to personalize it.</span></p>
        <div className={styles.entry} aria-live="polite">
          {prompt !== null ? <span className="text-sm text-accent-text">At the door · come in or head back</span>
            : rooms.length === 0 ? <button type="button" onClick={onCreate} className={styles.enter}>Create your first room</button>
              : <span className="text-sm text-muted">Approach a door to enter</span>}
        </div>
      </div>
      <div className={styles.bottomBar}>
        <div className={styles.dpad} role="group" aria-label="Walk controls">
          {([{ key: "ArrowLeft", Icon: ArrowLeft, label: "Walk left" }, { key: "ArrowUp", Icon: ArrowUp, label: "Walk up" }, { key: "ArrowDown", Icon: ArrowDown, label: "Walk down" }, { key: "ArrowRight", Icon: ArrowRight, label: "Walk right" }]).map(({ key, Icon, label }) => (
            <button key={key} type="button" aria-label={label} onPointerDown={event => {
              if (!active || editing) return;
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
              const index = promptRef.current;
              if (index !== null) {
                if (key === (index < 3 ? "ArrowUp" : "ArrowDown")) enterDoor();
                else if (key === (index < 3 ? "ArrowDown" : "ArrowUp")) leaveDoor();
                return;
              }
              destination.current = null; keys.current.add(key);
            }}
              onPointerUp={() => keys.current.delete(key)} onPointerCancel={stop} onLostPointerCapture={() => keys.current.delete(key)}
              onClick={event => { if (event.detail === 0) {
                const index = promptRef.current;
                if (index !== null) {
                  if (key === (index < 3 ? "ArrowUp" : "ArrowDown")) enterDoor();
                  else if (key === (index < 3 ? "ArrowDown" : "ArrowUp")) leaveDoor();
                } else { const delta = MOVEMENT[key]; walkTo({ x: position.x + delta.x * 45, y: position.y + delta.y * 45 }); }
              } }}><Icon size={18} /></button>
          ))}
        </div>
        {floorCount > 1 && <div className={styles.pagination}>{currentFloor > 0 && <button type="button" aria-label="Previous floor" disabled={!active || editing || prompt !== null} onClick={() => takeStairs(-1)}><ChevronLeft size={18} /></button>}<span>Floor {currentFloor + 1}</span>{currentFloor < floorCount - 1 && <button type="button" aria-label="Next floor" disabled={!active || editing || prompt !== null} onClick={() => takeStairs(1)}><ChevronRight size={18} /></button>}</div>}
      </div>
      <button ref={carpetButton} type="button" onClick={openEditor} className={styles.editCarpet}><Pencil size={14} aria-hidden="true" />Customize carpet</button>
      <dialog ref={editor} className={styles.editor} aria-labelledby="carpet-editor-title" onCancel={event => { event.preventDefault(); closeEditor(); }} onClose={() => setEditing(false)}>
        <form onSubmit={event => {
          event.preventDefault();
          const value = { headline: draft.headline.trim() || DEFAULT_CARPET.headline, caption: draft.caption.trim() || DEFAULT_CARPET.caption };
          setCarpet(value);
          try { localStorage.setItem(`koopi:carpet:${userId}`, JSON.stringify(value)); } catch {
            setStorageError("Carpet updated for this visit. Your browser couldn't save it for next time.");
            return;
          }
          closeEditor();
        }}>
          <div className={styles.editorHeading}><h3 id="carpet-editor-title">Make yourself at home</h3><button type="button" aria-label="Close carpet editor" onClick={closeEditor}><X size={20} /></button></div>
          <p className="mb-5 text-sm text-muted">Your carpet, your words. Saved for you on this device.</p>
          <label htmlFor="carpet-headline">Headline <span>{draft.headline.length}/22</span></label>
          <input id="carpet-headline" autoFocus maxLength={22} value={draft.headline} onChange={event => setDraft({ ...draft, headline: event.target.value })} />
          <label htmlFor="carpet-caption">Small caption <span>{draft.caption.length}/46</span></label>
          <input id="carpet-caption" maxLength={46} value={draft.caption} onChange={event => setDraft({ ...draft, caption: event.target.value })} />
          {storageError && <p role="status" className="mt-3 text-sm text-accent-text">{storageError}</p>}
          <div className={styles.editorActions}><button type="button" className={styles.secondary} onClick={() => setDraft(DEFAULT_CARPET)}>Reset text</button><button type="submit" className={styles.enter}>Save carpet</button></div>
        </form>
      </dialog>
      {!!rooms.length && <details className={styles.directory}><summary>Room directory · jump straight in</summary><ul>{visibleRooms.map(room => <li key={room.id}><Link href={`/room/${room.id}`}>{room.name}<ArrowRight size={15} aria-hidden="true" /></Link></li>)}</ul></details>}
    </div>
  );
}
