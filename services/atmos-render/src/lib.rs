//! Renders Dolby Atmos objects to binaural stereo the way Dolby Atmos for Headphones does
//! (DAP-VR 8.1.0), from its traced tuning: per-band PCA HRTF with a low-band ITD phase ramp,
//! the distance law, the LFE table, and the FOA room (FDN plus early reflections).

pub mod bits;
pub mod channels;
pub mod complex;
pub mod direct;
pub mod eac3_in;
pub mod filterbank;
pub mod input;
pub mod joc;
pub mod limiter;
pub mod loudness;
mod joc_tables;
pub mod objects;
pub mod qmf;
pub mod render;
mod qmf_window;
pub mod room;
pub mod truehd_in;
pub mod tuning;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
