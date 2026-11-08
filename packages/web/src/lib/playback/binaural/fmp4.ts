/*
 * The fragmented MP4 the binaural transmuxer reads (the transcoder's DASH audio, one track) and
 * writes (FLAC, one track). Only the boxes these streams use.
 */
import { FLAC_BITS, FLAC_RATE, streamInfo } from './flac';

interface Box {
  type: string;
  /** Where its content starts and ends in the buffer. */
  start: number;
  end: number;
  /** Where the box itself starts. */
  at: number;
}

function* boxes(data: Uint8Array, from = 0, to = data.length): Generator<Box> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield { type, start: at + header, end: at + size, at };
    at += size;
  }
}

function child(data: Uint8Array, parent: Box | null, type: string): Box | null {
  if (!parent) return null;
  for (const b of boxes(data, parent.start, parent.end))
    if (b.type === type) return b;
  return null;
}

function top(data: Uint8Array, type: string): Box | null {
  for (const b of boxes(data)) if (b.type === type) return b;
  return null;
}

/** The (only) track's timescale, from an init segment. */
export function initTimescale(data: Uint8Array): number | null {
  const mdhd = child(
    data,
    child(data, child(data, top(data, 'moov'), 'trak'), 'mdia'),
    'mdhd'
  );
  if (!mdhd) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = data[mdhd.start];
  return v.getUint32(mdhd.start + (version === 1 ? 20 : 12));
}

export interface Fragment {
  /** baseMediaDecodeTime, in the track's timescale. */
  start: number;
  /** Each sample's bytes and duration. */
  samples: { data: Uint8Array; duration: number }[];
}

/** Every fragment (moof + mdat) in a media segment. */
export function readFragments(data: Uint8Array): Fragment[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Fragment[] = [];
  for (const moof of boxes(data)) {
    if (moof.type !== 'moof') continue;
    const traf = child(data, moof, 'traf');
    const tfhd = child(data, traf, 'tfhd');
    const tfdt = child(data, traf, 'tfdt');
    if (!traf || !tfhd) continue;
    const hflags = v.getUint32(tfhd.start) & 0xffffff;
    let p = tfhd.start + 8; // version/flags, track_ID
    let base = moof.at;
    if (hflags & 0x1) {
      base = Number(v.getBigUint64(p));
      p += 8;
    }
    if (hflags & 0x2) p += 4;
    let defaultDuration = 0;
    let defaultSize = 0;
    if (hflags & 0x8) {
      defaultDuration = v.getUint32(p);
      p += 4;
    }
    if (hflags & 0x10) defaultSize = v.getUint32(p);
    let start = 0;
    if (tfdt) {
      const version = data[tfdt.start];
      start =
        version === 1
          ? Number(v.getBigUint64(tfdt.start + 4))
          : v.getUint32(tfdt.start + 4);
    }
    const samples: Fragment['samples'] = [];
    for (const trun of boxes(data, traf.start, traf.end)) {
      if (trun.type !== 'trun') continue;
      const flags = v.getUint32(trun.start) & 0xffffff;
      const count = v.getUint32(trun.start + 4);
      let q = trun.start + 8;
      let offset = 0;
      if (flags & 0x1) {
        offset = v.getInt32(q);
        q += 4;
      }
      if (flags & 0x4) q += 4;
      let at = base + offset;
      for (let i = 0; i < count; i++) {
        let duration = defaultDuration;
        let size = defaultSize;
        if (flags & 0x100) {
          duration = v.getUint32(q);
          q += 4;
        }
        if (flags & 0x200) {
          size = v.getUint32(q);
          q += 4;
        }
        if (flags & 0x400) q += 4;
        if (flags & 0x800) q += 4;
        samples.push({ data: data.subarray(at, at + size), duration });
        at += size;
      }
    }
    out.push({ start, samples });
  }
  return out;
}

class Writer {
  private parts: Uint8Array[] = [];
  private length = 0;
  bytes(...values: number[]) {
    this.push(new Uint8Array(values));
  }
  u16(n: number) {
    this.bytes((n >> 8) & 0xff, n & 0xff);
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0);
    this.push(b);
  }
  u64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n));
    this.push(b);
  }
  text(s: string) {
    this.push(new Uint8Array([...s].map((c) => c.charCodeAt(0))));
  }
  push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  get size() {
    return this.length;
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const w = new Writer();
  const size = 8 + content.reduce((n, c) => n + c.length, 0);
  w.u32(size);
  w.text(type);
  for (const c of content) w.push(c);
  return w.done();
}

function full(type: string, version: number, flags: number, body: Uint8Array) {
  const w = new Writer();
  w.bytes(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff);
  w.push(body);
  return box(type, w.done());
}

const raw = (fill: (w: Writer) => void) => {
  const w = new Writer();
  fill(w);
  return w.done();
};

/** The init segment of the FLAC track: 48 kHz stereo, 24-bit, timescale 48000. */
export function flacInit(): Uint8Array {
  const matrix = (w: Writer) => {
    for (const n of [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]) w.u32(n);
  };
  const mvhd = full(
    'mvhd',
    0,
    0,
    raw((w) => {
      w.u32(0);
      w.u32(0); // created, modified
      w.u32(1000); // timescale
      w.u32(0); // duration
      w.u32(0x10000); // rate
      w.u16(0x100); // volume
      w.bytes(...new Array(10).fill(0));
      matrix(w);
      w.bytes(...new Array(24).fill(0));
      w.u32(2); // next track
    })
  );
  const tkhd = full(
    'tkhd',
    0,
    3,
    raw((w) => {
      w.u32(0);
      w.u32(0);
      w.u32(1); // track 1
      w.u32(0);
      w.u32(0); // duration
      w.bytes(...new Array(8).fill(0));
      w.u16(0); // layer
      w.u16(0); // alternate group
      w.u16(0x100); // volume
      w.u16(0);
      matrix(w);
      w.u32(0);
      w.u32(0); // width, height
    })
  );
  const mdhd = full(
    'mdhd',
    0,
    0,
    raw((w) => {
      w.u32(0);
      w.u32(0);
      w.u32(FLAC_RATE);
      w.u32(0);
      w.u16(0x55c4); // 'und'
      w.u16(0);
    })
  );
  const hdlr = full(
    'hdlr',
    0,
    0,
    raw((w) => {
      w.u32(0);
      w.text('soun');
      w.u32(0);
      w.u32(0);
      w.u32(0);
      // eslint-disable-next-line lingui/no-unlocalized-strings -- a box field, not UI text
      w.text('Binaural\0');
    })
  );
  const smhd = full(
    'smhd',
    0,
    0,
    raw((w) => w.u32(0))
  );
  const dref = full(
    'dref',
    0,
    0,
    raw((w) => {
      w.u32(1);
      w.push(full('url ', 0, 1, new Uint8Array(0)));
    })
  );
  // dfLa: the STREAMINFO block, marked last
  const info = streamInfo();
  const dfla = full(
    'dfLa',
    0,
    0,
    raw((w) => {
      w.bytes(0x80, 0, 0, info.length);
      w.push(info);
    })
  );
  const flac = box(
    'fLaC',
    raw((w) => {
      w.bytes(0, 0, 0, 0, 0, 0);
      w.u16(1); // data reference index
      w.u32(0);
      w.u32(0);
      w.u16(2); // channels
      w.u16(FLAC_BITS);
      w.u16(0);
      w.u16(0);
      w.u32(FLAC_RATE * 65536);
    }),
    dfla
  );
  const stsd = full(
    'stsd',
    0,
    0,
    raw((w) => {
      w.u32(1);
      w.push(flac);
    })
  );
  const empty = (type: string, extra = 0) =>
    full(
      type,
      0,
      0,
      raw((w) => {
        for (let i = 0; i <= extra; i++) w.u32(0);
      })
    );
  const stbl = box(
    'stbl',
    stsd,
    empty('stts'),
    empty('stsc'),
    empty('stsz', 1),
    empty('stco')
  );
  const minf = box('minf', smhd, box('dinf', dref), stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const trex = full(
    'trex',
    0,
    0,
    raw((w) => {
      w.u32(1); // track
      w.u32(1); // sample description
      w.u32(0);
      w.u32(0);
      w.u32(0);
    })
  );
  const moov = box('moov', mvhd, trak, box('mvex', trex));
  const ftyp = box(
    'ftyp',
    raw((w) => {
      w.text('iso6');
      w.u32(0);
      w.text('iso6');
      w.text('isom');
      w.text('mp41');
    })
  );
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
}

/**
 * A fragment of the FLAC track: `frames` (FLAC frames, each one MP4 sample) with their sample
 * counts, starting at `start` (in 48 kHz samples).
 */
export function flacFragment(
  sequence: number,
  start: number,
  frames: { data: Uint8Array; samples: number }[]
): Uint8Array {
  const trunBody = (dataOffset: number) =>
    raw((w) => {
      w.u32(frames.length);
      w.u32(dataOffset);
      for (const f of frames) {
        w.u32(f.samples);
        w.u32(f.data.length);
      }
    });
  const build = (dataOffset: number) => {
    const mfhd = full(
      'mfhd',
      0,
      0,
      raw((w) => w.u32(sequence))
    );
    // default-base-is-moof; track 1
    const tfhd = full(
      'tfhd',
      0,
      0x020000,
      raw((w) => w.u32(1))
    );
    const tfdt = full(
      'tfdt',
      1,
      0,
      raw((w) => w.u64(start))
    );
    // data offset, sample duration, sample size
    const trun = full('trun', 0, 0x000301, trunBody(dataOffset));
    return box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  };
  const moofSize = build(0).length;
  const moof = build(moofSize + 8);
  const payload = frames.reduce((n, f) => n + f.data.length, 0);
  const mdat = new Uint8Array(8 + payload);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  let at = 8;
  for (const f of frames) {
    mdat.set(f.data, at);
    at += f.data.length;
  }
  const out = new Uint8Array(moof.length + mdat.length);
  out.set(moof);
  out.set(mdat, moof.length);
  return out;
}
