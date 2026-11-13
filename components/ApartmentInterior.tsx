"use client";

import { type Point } from "@/lib/clubhouseMovement";
import { APARTMENT_DESTINATIONS, APARTMENT_EXIT, APARTMENT_FURNITURE, APARTMENT_WALLS } from "@/lib/apartmentMovement";

function Furniture() {
  const find = (id: string) => APARTMENT_FURNITURE.find(item => item.id === id)!;
  return <>
    <g><rect {...find("wardrobe")} rx="4" fill="#b09b85" stroke="#d5c3ad" strokeWidth="2" /><path d="M190 49v28m-8-16v7m16-7v7" stroke="#64544b" strokeWidth="2" /></g>
    <g><rect {...find("bed")} rx="8" fill="#535b78" stroke="#b7bad3" strokeWidth="3" /><rect x="87" y="99" width="130" height="44" rx="5" fill="#e1ddd6" /><rect x="92" y="104" width="53" height="28" rx="5" fill="#f2eee7" /><rect x="159" y="104" width="53" height="28" rx="5" fill="#f2eee7" /><rect x="87" y="145" width="130" height="73" rx="3" fill="#7d8eb6" /><path d="M88 160h128m-116 4v51m104-51v51" stroke="#a6b3d5" strokeWidth="2" /></g>
    <g><rect {...find("nightstand")} rx="5" fill="#b09b85" stroke="#d5c3ad" strokeWidth="2" /><circle cx="271" cy="115" r="10" fill="#efe2ba" stroke="#807566" strokeWidth="3" /></g>
    <g><rect {...find("desk")} rx="5" fill="#b09b85" stroke="#d5c3ad" strokeWidth="2" /><rect x="490" y="73" width="65" height="28" rx="3" fill="#253044" stroke="#a7b8c9" strokeWidth="2" /><rect x="498" y="78" width="49" height="17" rx="1" fill="#9aabff" /><path d="M486 108h74" stroke="#dfd8c9" strokeWidth="4" /><rect {...find("desk-chair")} rx="10" fill="#708c86" stroke="#3f5953" strokeWidth="4" /></g>
    <g><rect {...find("bookshelf")} rx="3" fill="#98816a" stroke="#c8b49c" strokeWidth="2" />{[0,1,2,3,4,5].map(i=><rect key={i} x={547+i*9} y="241" width="6" height={i%2?26:21} rx="1" fill={["#9aabff","#c6a980","#86a69d"][i%3]} />)}</g>
    <g><rect {...find("shower")} rx="5" fill="#86a4aa" stroke="#d5e2e3" strokeWidth="3" /><rect x="808" y="68" width="84" height="72" rx="4" fill="#a6bec1" /><path d="M850 68v72m-42-36h84" stroke="#c6d8da" /><circle cx="877" cy="82" r="6" fill="#dce8e9" /></g>
    <g><rect {...find("toilet")} rx="12" fill="#d7e1df" stroke="#829b9a" strokeWidth="2" /><ellipse cx="713" cy="93" rx="12" ry="16" fill="#a4bdbb" /><rect x="697" y="67" width="32" height="10" rx="3" fill="#ecf0eb" /></g>
    <g><rect {...find("sink")} rx="4" fill="#b7c8c6" stroke="#e0e7df" strokeWidth="2" /><ellipse cx="729" cy="258" rx="19" ry="9" fill="#6e9292" /><path d="M729 246v8" stroke="#f0f2ec" strokeWidth="3" /></g>
    <g><rect {...find("kitchen-counter")} rx="5" fill="#9a8a79" stroke="#cabca9" strokeWidth="3" /><rect x="68" y="339" width="69" height="35" rx="4" fill="#789798" stroke="#c6d4cb" strokeWidth="2" /><path d="M101 340v8" stroke="#eff2df" strokeWidth="3" /><rect x="222" y="338" width="76" height="36" rx="4" fill="#29333a" />{[236,258,280].map(cx=><circle key={cx} cx={cx} cy="356" r="7" fill="none" stroke="#9cabb5" strokeWidth="2" />)}<path d="M153 345v22m20-22v22m20-22v22" stroke="#d7c6b1" strokeWidth="2" /></g>
    <g><rect {...find("fridge")} rx="6" fill="#b2bfbd" stroke="#dfe4dd" strokeWidth="3" /><path d="M62 435h54m-12-14v8m0 16v18" stroke="#536566" strokeWidth="3" /></g>
    <g><rect {...find("dining-table")} rx="12" fill="#b6a18b" stroke="#decbb1" strokeWidth="3" /><circle cx="280" cy="476" r="14" fill="#e7e2d2" /><circle cx="321" cy="496" r="14" fill="#e7e2d2" /><rect {...find("dining-chair-left")} rx="6" fill="#718e87" stroke="#3e5954" strokeWidth="3" /><rect {...find("dining-chair-right")} rx="6" fill="#718e87" stroke="#3e5954" strokeWidth="3" /></g>
    <rect x="644" y="426" width="224" height="112" rx="10" fill="#3c5267" stroke="#7d96a8" strokeWidth="2" /><rect x="653" y="435" width="206" height="94" rx="6" fill="none" stroke="#7d96a8" strokeDasharray="3 5" />
    <g><rect {...find("sofa")} rx="12" fill="#6d8899" stroke="#a8bdc7" strokeWidth="3" /><rect x="729" y="348" width="138" height="14" rx="6" fill="#94a9b7" /><path d="M770 365v33m52-33v33" stroke="#9db4c1" strokeWidth="2" /><rect x="724" y="361" width="12" height="42" rx="5" fill="#94a9b7" /><rect x="860" y="361" width="12" height="42" rx="5" fill="#94a9b7" /></g>
    <g><rect {...find("coffee-table")} rx="12" fill="#b4a08b" stroke="#dcc7b0" strokeWidth="2" /><rect x="713" y="459" width="26" height="19" rx="2" fill="#d6d8ec" /><circle cx="759" cy="473" r="7" fill="#eee4ce" /></g>
    <g><rect {...find("tv-console")} rx="5" fill="#8a7f75" stroke="#c2b6a3" strokeWidth="2" /><rect x="872" y="464" width="17" height="63" rx="3" fill="#171f2c" stroke="#718799" strokeWidth="2" /><path d="M881 473v43" stroke="#405372" strokeWidth="4" /></g>
  </>;
}

export default function ApartmentInterior({ displayName, onWalk }: { displayName: string; onWalk: (point: Point) => void }) {
  return <>
    <defs>
      <pattern id="apartment-wood" width="80" height="26" patternUnits="userSpaceOnUse"><rect width="80" height="26" fill="#5e5953" /><path d="M0 0h80v26" fill="none" stroke="#736b60" strokeWidth="1" /></pattern>
      <pattern id="apartment-tile" width="28" height="28" patternUnits="userSpaceOnUse"><rect width="28" height="28" fill="#465c60" /><path d="M28 0H0v28" fill="none" stroke="#637d7d" strokeWidth="1" /></pattern>
    </defs>
    <rect width="960" height="620" fill="#1c2328" />
    <rect x="32" y="28" width="896" height="564" rx="12" fill="url(#apartment-wood)" stroke="#10191e" strokeWidth="16" />
    <rect x="46" y="42" width="332" height="244" fill="#4b5261" opacity=".5" />
    <rect x="664" y="42" width="250" height="238" fill="url(#apartment-tile)" />
    <rect x="46" y="302" width="290" height="274" fill="#696257" opacity=".4" />
    <rect x="404" y="44" width="234" height="240" rx="8" fill="#283744" opacity=".35" />
    <path d="M402 316h480" stroke="#9b8c7c" strokeDasharray="3 6" opacity=".45" />
    <Furniture />
    {APARTMENT_WALLS.map(wall=><g key={wall.id}><rect {...wall} rx="2" fill="#20292f" /><path d={`M${wall.x+2} ${wall.y+2}h${wall.width-4}`} stroke="#84918f" strokeWidth="2" /></g>)}
    <path d="M383 207v65m274-103v54" stroke="#9aabff" strokeWidth="3" strokeDasharray="5 5" />
    <path d="M94 35h180m-180 4h180m170-4h130m-130 4h130m224-4h90m-90 4h90" stroke="#a6bccb" strokeWidth="3" />
    <text x="216" y="266" textAnchor="middle" fill="#e2e5ef" fontSize="15" fontWeight="600">Bedroom</text>
    <text x="778" y="218" textAnchor="middle" fill="#e0edeb" fontSize="15" fontWeight="600">Bathroom</text>
    <text x="514" y="205" textAnchor="middle" fill="#dce5f0" fontSize="14">Workspace</text>
    <text x="180" y="402" textAnchor="middle" fill="#e5ded2" fontSize="15" fontWeight="600">Kitchen &amp; dining</text>
    <text x="575" y="392" textAnchor="middle" fill="#e5e9ed" fontSize="15" fontWeight="600">Living room</text>
    {APARTMENT_DESTINATIONS.map(({name,point})=><g key={name} role="button" tabIndex={-1} aria-label={`Walk to ${name.toLowerCase()}`} onClick={event=>{event.stopPropagation();onWalk(point);}}><title>{name}</title><rect x={point.x-30} y={point.y-24} width="60" height="48" rx="6" fill="transparent" /></g>)}
    <g role="button" tabIndex={-1} aria-label="Walk to apartment exit" onClick={event=>{event.stopPropagation();onWalk({x:480,y:562});}}>
      <title>Return to the first floor</title>
      <rect {...APARTMENT_EXIT} rx="6" fill="#253c58" stroke="#a6bcff" strokeWidth="2" />
      <path d="M480 553v19m-7-7 7 7 7-7" fill="none" stroke="#dce4ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="412" y="532" width="136" height="60" fill="transparent" />
    </g>
    <text x="480" y="611" textAnchor="middle" fill="#bac7df" fontSize="12">{displayName.length > 20 ? "Your apartment" : `${displayName}'s apartment`} · exit to first floor</text>
  </>;
}
