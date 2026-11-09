import { t } from '@lingui/core/macro';
import React from 'react';
import { cn } from '@aiostreams/ui/core/styling';
import {
  BED_LABELS,
  SILENT_AFTER,
  sceneStore,
  silentElements,
  type SceneElement,
  type SceneSnapshot,
} from '../../lib/playback/binaural/objects';

/**
 * Whether the binaural audio is rendered in this browser now (there's a scene to show), and
 * whether the view is on.
 */
export function useSceneView() {
  const live = React.useSyncExternalStore(
    sceneStore.subscribe,
    () => sceneStore.live
  );
  const shown = React.useSyncExternalStore(
    sceneStore.subscribe,
    () => sceneStore.shown
  );
  return { live, shown, toggle: sceneStore.toggle };
}

const useDisabled = () =>
  React.useSyncExternalStore(sceneStore.subscribe, () => sceneStore.disabled);

const dB = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v: number) => {
  const d = dB(v);
  return Number.isFinite(d) ? d.toFixed(1) : '-∞';
};
/** A dot's radius at unit depth from the input level: -60 dBFS and under smallest. */
const radius = (level: number) =>
  2.5 + 7 * Math.min(1, Math.max(0, (dB(level) + 60) / 60));

const COLOURS: Record<SceneElement['kind'], string> = {
  object: '#38bdf8',
  bed: '#fbbf24',
  isf: '#a78bfa',
  lfe: '#f87171',
  bypass: '#e5e5e5',
  unknown: '#a3a3a3',
};
const OFF = '#737373';

/** Every element's name, in stream order: bed labels, then Object 1, 2, … */
function names(elements: SceneElement[]): string[] {
  const counts = new Map<string, number>();
  return elements.map((e, i) => {
    const bed = e.bed ?? 0;
    if (e.kind === 'bed') return BED_LABELS[bed] ?? t`Bed ${bed}`;
    if (e.kind === 'lfe') return t`LFE`;
    // E's slots 17/18: summed into output L/R, never rendered in the room
    if (e.kind === 'bypass')
      return e.bed === 1 ? t`Stereo bypass R` : t`Stereo bypass L`;
    const n = (counts.get(e.kind) ?? 0) + 1;
    counts.set(e.kind, n);
    if (e.kind === 'object') return t`Object ${n}`;
    if (e.kind === 'isf') return t`ISF ${n}`;
    const input = i + 1;
    return t`Input ${input}`;
  });
}

/** How an element is shown: switched off, without signal, or sounding. */
type Look = 'off' | 'silent' | 'on';
const lookOf = (
  e: SceneElement,
  i: number,
  silent: Set<number>,
  disabled: ReadonlySet<number>
): Look =>
  disabled.has(i) ? 'off' : !e.active || silent.has(i) ? 'silent' : 'on';

// ---------------------------------------------------------------- the 3D room

const W = 440;
const H = 270;
/** Camera distance from the room's centre, in room widths. */
const DISTANCE = 2.6;
const FOCAL = 360;
const VIEW = { yaw: -28, pitch: 24 };

/**
 * Dolby x (left to right), y (front to back), z (floor to ceiling) to the screen, seen from
 * behind the room and above it, turned by `yaw` and tilted by `pitch` (degrees).
 */
function projector(yaw: number, pitch: number) {
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
  return (x: number, y: number, z: number) => {
    // right, up, toward the camera (the back of the room)
    const X = x - 0.5;
    const Y = z - 0.5;
    const Z = y - 0.5;
    const x1 = X * ca + Z * sa;
    const z1 = -X * sa + Z * ca;
    const y2 = Y * cb - z1 * sb;
    const z2 = Y * sb + z1 * cb;
    const depth = DISTANCE - z2;
    return {
      x: W / 2 + (FOCAL * x1) / depth,
      y: H / 2 - (FOCAL * y2) / depth,
      depth,
    };
  };
}

const CORNERS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];
/** The front wall's edges (y = 0), drawn brighter. */
const FRONT = new Set(['0-1', '4-5', '0-4', '1-5']);

function Room3D({
  elements,
  labels,
  looks,
  hover,
  onHover,
}: {
  elements: SceneElement[];
  labels: string[];
  looks: Look[];
  hover: number | null;
  onHover: (i: number | null) => void;
}) {
  const [view, setView] = React.useState(VIEW);
  const drag = React.useRef<{
    x: number;
    y: number;
    moved: boolean;
    /** The dot pressed on, if any: a click (no drag) switches it. */
    element: number | null;
  } | null>(null);
  const at = projector(view.yaw, view.pitch);
  const line = (p: [number, number, number], q: [number, number, number]) => {
    const [a, b] = [at(...p), at(...q)];
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };
  const grid = [0.25, 0.5, 0.75].flatMap((v) => [
    line([v, 0, 0], [v, 1, 0]),
    line([0, v, 0], [1, v, 0]),
  ]);
  const dots = elements
    .map((e, i) => ({ e, i, p: e.pos && at(e.pos[0], e.pos[1], e.pos[2]) }))
    .filter((d) => d.p)
    // far first, so near ones are drawn over them
    .sort((a, b) => b.p!.depth - a.p!.depth);
  const head = at(0.5, 0.5, 0);
  const nose = at(0.5, 0.42, 0);
  const front = at(0.5, 0, 1.08);
  const hovered = hover != null ? dots.find((d) => d.i === hover) : undefined;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={t`The room in 3D: drag to turn it, double-click to reset`}
      className="max-h-[min(270px,38vh)] w-full shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
      onPointerDown={(ev) => {
        const index = (ev.target as Element)
          .closest('[data-element]')
          ?.getAttribute('data-element');
        drag.current = {
          x: ev.clientX,
          y: ev.clientY,
          moved: false,
          element: index == null ? null : Number(index),
        };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        const d = drag.current;
        if (!d) return;
        const [dx, dy] = [ev.clientX - d.x, ev.clientY - d.y];
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        d.x = ev.clientX;
        d.y = ev.clientY;
        setView((v) => ({
          yaw: v.yaw + dx * 0.6,
          pitch: Math.min(89, Math.max(-10, v.pitch + dy * 0.4)),
        }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        // a click, not a drag, on a dot: switch that element on or off
        if (d && !d.moved && d.element != null)
          sceneStore.toggleElement(d.element);
      }}
      onDoubleClick={() => setView(VIEW)}
    >
      {grid.map((g, k) => (
        <line key={`g${k}`} {...g} stroke="rgba(255,255,255,0.08)" />
      ))}
      {EDGES.map(([p, q]) => (
        <line
          key={`${p}-${q}`}
          {...line(CORNERS[p], CORNERS[q])}
          stroke={
            FRONT.has(`${p}-${q}`)
              ? 'rgba(255,255,255,0.55)'
              : 'rgba(255,255,255,0.22)'
          }
        />
      ))}
      <text
        x={front.x}
        y={front.y}
        textAnchor="middle"
        className="fill-white/60 text-[10px]"
      >
        {t`front`}
      </text>
      {/* the listener, facing the front */}
      <line
        x1={head.x}
        y1={head.y}
        x2={nose.x}
        y2={nose.y}
        stroke="white"
        strokeWidth={1.5}
      />
      <circle cx={head.x} cy={head.y} r={3.5} fill="white" />
      {dots.map(({ e, i, p }) => {
        const look = looks[i];
        const colour = look === 'off' ? OFF : COLOURS[e.kind];
        const floor = at(e.pos![0], e.pos![1], 0);
        const r = (radius(e.level) * DISTANCE) / p!.depth;
        return (
          <g
            key={i}
            data-element={i}
            className="cursor-pointer"
            onPointerEnter={() => onHover(i)}
            onPointerLeave={() => onHover(null)}
          >
            {/* its height: a line down to the floor */}
            <line
              x1={p!.x}
              y1={p!.y}
              x2={floor.x}
              y2={floor.y}
              stroke={colour}
              strokeOpacity={0.3}
              strokeDasharray="2 2"
            />
            <circle
              cx={floor.x}
              cy={floor.y}
              r={1.2}
              fill={colour}
              fillOpacity={0.4}
            />
            <circle
              cx={p!.x}
              cy={p!.y}
              r={r + (hover === i ? 2 : 0)}
              fill={look === 'on' ? colour : 'none'}
              fillOpacity={0.75}
              stroke={colour}
              strokeOpacity={look === 'on' ? 1 : 0.5}
              strokeDasharray={look === 'off' ? '2 1.5' : undefined}
            />
            <title>{labels[i]}</title>
          </g>
        );
      })}
      {hovered && (
        <text
          x={hovered.p!.x + 8}
          y={hovered.p!.y - 8}
          className="pointer-events-none fill-white text-[11px]"
        >
          {labels[hovered.i]}
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- the list

function Scene({
  snapshot,
  silent,
}: {
  snapshot: SceneSnapshot;
  silent: Set<number>;
}) {
  const disabled = useDisabled();
  const [hover, setHover] = React.useState<number | null>(null);
  const elements = snapshot.elements;
  const labels = names(elements);
  const looks = elements.map((e, i) => lookOf(e, i, silent, disabled));
  const modes: Record<string, string> = {
    off: t`Off`,
    near: t`Near`,
    far: t`Far`,
    mid: t`Mid`,
  };
  return (
    <>
      <Room3D
        elements={elements}
        labels={labels}
        looks={looks}
        hover={hover}
        onHover={setHover}
      />
      <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain">
        <table className="w-full text-end text-[11px] leading-tight tabular-nums [&_td]:ps-2 [&_td]:py-px [&_th]:ps-2 [&_td:first-child]:ps-0 [&_th:first-child]:ps-0">
          <thead className="sticky top-0 z-10 bg-neutral-950 text-white/60">
            <tr>
              <th className="font-normal">
                <span className="sr-only">{t`On`}</span>
              </th>
              <th
                className="font-normal"
                title={t`Its slot in Windows' renderer, as from a fresh start: it can shift after a seek`}
              >
                {t`Slot`}
              </th>
              <th className="text-start font-normal">{t`Input`}</th>
              <th className="text-start font-normal">{t`Mode`}</th>
              <th className="font-normal">x</th>
              <th className="font-normal">y</th>
              <th className="font-normal">z</th>
              <th className="whitespace-nowrap font-normal">{t`Gain dB`}</th>
              <th className="whitespace-nowrap font-normal">{t`Level dB`}</th>
              <th className="font-normal">
                <span className="sr-only">{t`Only this`}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {elements.map((e, i) => {
              const look = looks[i];
              const label = labels[i];
              return (
                <tr
                  key={i}
                  className={cn(
                    'cursor-pointer hover:bg-white/10',
                    hover === i && 'bg-white/10',
                    look === 'silent' && 'text-white/45',
                    look === 'off' && 'text-white/30 line-through'
                  )}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => sceneStore.toggleElement(i)}
                >
                  <td>
                    <input
                      type="checkbox"
                      className="size-3 cursor-pointer align-middle accent-sky-400"
                      checked={look !== 'off'}
                      onChange={() => sceneStore.toggleElement(i)}
                      onClick={(ev) => ev.stopPropagation()}
                      aria-label={t`Render ${label}`}
                    />
                  </td>
                  <td>{e.slot ?? '–'}</td>
                  <td className="whitespace-nowrap text-start">
                    <span
                      className={cn(
                        'me-1 inline-block size-2 rounded-full',
                        look !== 'on' && 'opacity-40'
                      )}
                      style={{
                        background: look === 'off' ? OFF : COLOURS[e.kind],
                      }}
                    />
                    {label}
                  </td>
                  <td className="whitespace-nowrap text-start">
                    {e.mode ? modes[e.mode] : '–'}
                    {!e.active && ` (${t`inactive`})`}
                  </td>
                  <td>{e.pos ? e.pos[0].toFixed(2) : '–'}</td>
                  <td>{e.pos ? e.pos[1].toFixed(2) : '–'}</td>
                  <td>{e.pos ? e.pos[2].toFixed(2) : '–'}</td>
                  <td>{fmtDb(e.gain)}</td>
                  <td>{fmtDb(e.level)}</td>
                  <td>
                    <button
                      type="button"
                      className="rounded px-1 text-white/50 hover:bg-white/15 hover:text-white"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        sceneStore.only(i, elements.length);
                      }}
                      title={t`Render only ${label}`}
                    >
                      {t`only`}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Counts({
  snapshot,
  silent,
}: {
  snapshot: SceneSnapshot;
  silent: Set<number>;
}) {
  const total = snapshot.elements.length;
  const sounding = total - silent.size;
  const time = snapshot.time.toFixed(2);
  return (
    <span className="ms-2 font-mono text-xs font-normal text-white/60">
      {t`${sounding} of ${total} with signal`} · {time} s
    </span>
  );
}

function Switched() {
  const disabled = useDisabled();
  if (!disabled.size) return null;
  const count = disabled.size;
  return (
    <p className="mb-1 flex items-center gap-2 text-[11px] text-amber-300/90">
      {t`${count} switched off, rendered again from here`}
      <button
        type="button"
        className="ms-auto whitespace-nowrap rounded bg-white/10 px-1.5 py-px text-white hover:bg-white/20"
        onClick={sceneStore.allOn}
      >
        {t`All on`}
      </button>
    </p>
  );
}

/**
 * The binaural renderer's scene at the video's current time: where each object, bed channel and
 * the LFE is, its render mode, metadata gain and input level, as the renderer in this browser
 * renders it. Elements can be switched off (any number of them), which renders them as silence.
 */
export function SceneOverlay({
  video,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
}) {
  const { live, shown } = useSceneView();
  const [view, setView] = React.useState<{
    snapshot: SceneSnapshot;
    silent: Set<number>;
  } | null>(null);
  React.useEffect(() => {
    if (!live || !shown) return;
    let frame = 0;
    const tick = () => {
      const el = video.current;
      const snapshot = el ? sceneStore.at(el.currentTime) : null;
      setView(
        snapshot && {
          snapshot,
          silent: silentElements(
            sceneStore.between(snapshot.time - SILENT_AFTER, snapshot.time),
            snapshot
          ),
        }
      );
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [live, shown, video]);
  if (!live || !shown) return null;
  return (
    // Above the player's controls (z-10, rendered after it), whose gesture layer covers the
    // screen and would take its clicks; under their menus (portalled, z-50).
    <section
      data-ui="player-scene"
      aria-label={t`Audio objects`}
      className="fixed end-[calc(1rem+env(safe-area-inset-right))] top-[calc(4.5rem+env(safe-area-inset-top))] z-20 flex max-h-[calc(100vh-9rem)] w-[30rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg bg-black/75 px-3 py-2 font-mono text-xs leading-relaxed text-white/90"
    >
      <h2 className="mb-1 font-sans text-sm font-medium">
        {t`Audio objects`}
        {view && <Counts {...view} />}
      </h2>
      <Switched />
      {view ? (
        <Scene {...view} />
      ) : (
        <p className="text-white/60">{t`Waiting for the renderer…`}</p>
      )}
    </section>
  );
}
