import { t } from '@lingui/core/macro';
import React from 'react';
import {
  BED_LABELS,
  sceneStore,
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

const dB = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v: number) => {
  const d = dB(v);
  return Number.isFinite(d) ? d.toFixed(1) : '-∞';
};
/** A dot's radius from the input level: -60 dBFS and under smallest. */
const radius = (level: number) =>
  2 + 9 * Math.min(1, Math.max(0, (dB(level) + 60) / 60));

const COLOURS: Record<SceneElement['kind'], string> = {
  object: '#38bdf8',
  bed: '#fbbf24',
  isf: '#a78bfa',
  lfe: '#f87171',
  unknown: '#a3a3a3',
};

function name(e: SceneElement, i: number, counts: Map<string, number>) {
  const bed = e.bed ?? 0;
  if (e.kind === 'bed') return BED_LABELS[bed] ?? t`Bed ${bed}`;
  if (e.kind === 'lfe') return t`LFE`;
  const n = (counts.get(e.kind) ?? 0) + 1;
  counts.set(e.kind, n);
  if (e.kind === 'object') return t`Object ${n}`;
  if (e.kind === 'isf') return t`ISF ${n}`;
  const input = i + 1;
  return t`Input ${input}`;
}

/** One view of the room: `a` across, `b` down, both 0..1. */
function Room({
  title,
  elements,
  axes,
  across,
  down,
}: {
  title: string;
  elements: SceneElement[];
  axes: [number, number];
  across: string;
  down: string;
}) {
  const size = 140;
  const pad = 12;
  const at = (v: number) => pad + v * (size - 2 * pad);
  return (
    <figure className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={title}
      >
        <rect
          x={pad}
          y={pad}
          width={size - 2 * pad}
          height={size - 2 * pad}
          fill="none"
          stroke="rgba(255,255,255,0.3)"
        />
        {/* the listener */}
        <circle
          cx={at(0.5)}
          cy={at(axes[1] === 2 ? 1 : 0.5)}
          r={3}
          fill="white"
        />
        {elements.map((e, i) =>
          e.pos ? (
            <circle
              key={i}
              cx={at(e.pos[axes[0]])}
              // z grows upwards
              cy={at(axes[1] === 2 ? 1 - e.pos[2] : e.pos[axes[1]])}
              r={radius(e.level)}
              fill={e.active ? COLOURS[e.kind] : 'none'}
              fillOpacity={0.7}
              stroke={COLOURS[e.kind]}
              strokeOpacity={e.active ? 1 : 0.4}
            />
          ) : null
        )}
      </svg>
      <figcaption className="text-[10px] leading-tight text-white/60">
        {title}
        <br />
        {across} → · {down} ↓
      </figcaption>
    </figure>
  );
}

function Scene({ snapshot }: { snapshot: SceneSnapshot }) {
  const counts = new Map<string, number>();
  const rows = snapshot.elements.map((e, i) => ({
    e,
    label: name(e, i, counts),
  }));
  const modes: Record<string, string> = {
    off: t`Off`,
    near: t`Near`,
    far: t`Far`,
    mid: t`Mid`,
  };
  return (
    <>
      <div className="flex gap-3">
        <Room
          title={t`From above`}
          elements={snapshot.elements}
          axes={[0, 1]}
          across={t`left to right`}
          down={t`front to back`}
        />
        <Room
          title={t`From the side`}
          elements={snapshot.elements}
          axes={[1, 2]}
          across={t`front to back`}
          down={t`ceiling to floor`}
        />
      </div>
      <table className="mt-2 w-full text-end text-[11px] leading-tight tabular-nums [&_td]:ps-2 [&_td]:py-px [&_th]:ps-2 [&_td:first-child]:ps-0 [&_th:first-child]:ps-0">
        <thead className="text-white/60">
          <tr>
            <th className="text-start font-normal">{t`Input`}</th>
            <th className="text-start font-normal">{t`Mode`}</th>
            <th className="font-normal">x</th>
            <th className="font-normal">y</th>
            <th className="font-normal">z</th>
            <th className="whitespace-nowrap font-normal">{t`Gain dB`}</th>
            <th className="whitespace-nowrap font-normal">{t`Level dB`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ e, label }, i) => (
            <tr key={i} className={e.active ? '' : 'text-white/40'}>
              <td className="whitespace-nowrap text-start">
                <span
                  className="me-1 inline-block size-2 rounded-full"
                  style={{ background: COLOURS[e.kind] }}
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
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The binaural renderer's scene at the video's current time: where each object, bed channel and
 * the LFE is, its render mode, metadata gain and input level, as the renderer in this browser
 * renders it.
 */
export function SceneOverlay({
  video,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
}) {
  const { live, shown } = useSceneView();
  const [snapshot, setSnapshot] = React.useState<SceneSnapshot | null>(null);
  React.useEffect(() => {
    if (!live || !shown) return;
    let frame = 0;
    const tick = () => {
      const el = video.current;
      setSnapshot(el ? sceneStore.at(el.currentTime) : null);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [live, shown, video]);
  if (!live || !shown) return null;
  return (
    <section
      data-ui="player-scene"
      aria-label={t`Audio objects`}
      className="pointer-events-none fixed end-[calc(1rem+env(safe-area-inset-right))] top-[calc(4.5rem+env(safe-area-inset-top))] max-h-[calc(100vh-10rem)] w-[25rem] overflow-hidden rounded-lg bg-black/70 px-3 py-2 font-mono text-xs leading-relaxed text-white/90"
    >
      <h2 className="mb-1 font-sans text-sm font-medium">
        {t`Audio objects`}
        {snapshot && (
          <span className="ms-2 font-mono text-xs font-normal text-white/60">
            {snapshot.elements.length} · {snapshot.time.toFixed(2)} s
          </span>
        )}
      </h2>
      {snapshot ? (
        <Scene snapshot={snapshot} />
      ) : (
        <p className="text-white/60">{t`Waiting for the renderer…`}</p>
      )}
    </section>
  );
}
