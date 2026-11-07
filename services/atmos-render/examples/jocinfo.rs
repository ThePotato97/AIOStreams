//! Prints the JOC downmix configs and object counts of a raw E-AC-3 stream (diagnostic).
use std::collections::BTreeMap;
fn main() {
    let path = std::env::args().nth(1).expect("path");
    let data = std::fs::read(path).unwrap();
    let mut seen: BTreeMap<(u32, usize, usize), usize> = BTreeMap::new();
    let mut gains: BTreeMap<String, usize> = BTreeMap::new();
    let mut i = 0;
    while i + 6 < data.len() {
        if data[i] != 0x0B || data[i + 1] != 0x77 {
            i += 1;
            continue;
        }
        let words = (((data[i + 2] as usize & 7) << 8) | data[i + 3] as usize) + 1;
        let end = (i + words * 2).min(data.len());
        if let Some(c) = atmos_render::joc::find_container(&data[i..end]) {
            if let Some(j) = c.joc {
                *seen.entry((j.dmx, j.channels, j.objects)).or_default() += 1;
                *gains.entry(format!("{:.5}", j.gain)).or_default() += 1;
            }
        }
        i += words * 2;
    }
    for ((dmx, ch, obj), n) in seen {
        println!("dmx config {dmx} ({ch} channels), {obj} objects: {n} frames");
    }
    for (g, n) in gains {
        println!("clip gain {g}: {n} frames");
    }
}
