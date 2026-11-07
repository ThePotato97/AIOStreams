//! A minimal complex number for the per-band math.

use std::ops::{Add, AddAssign, Mul, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct C32 {
    pub re: f32,
    pub im: f32,
}

impl C32 {
    pub const ZERO: C32 = C32 { re: 0.0, im: 0.0 };

    pub const fn new(re: f32, im: f32) -> Self {
        Self { re, im }
    }
    pub const fn real(re: f32) -> Self {
        Self { re, im: 0.0 }
    }
    pub fn cis(phase: f32) -> Self {
        let (s, c) = phase.sin_cos();
        Self { re: c, im: s }
    }
    pub fn conj(self) -> Self {
        Self { re: self.re, im: -self.im }
    }
    pub fn norm2(self) -> f32 {
        self.re * self.re + self.im * self.im
    }
    pub fn scale(self, k: f32) -> Self {
        Self { re: self.re * k, im: self.im * k }
    }
}

impl Add for C32 {
    type Output = C32;
    fn add(self, o: C32) -> C32 {
        C32::new(self.re + o.re, self.im + o.im)
    }
}
impl Sub for C32 {
    type Output = C32;
    fn sub(self, o: C32) -> C32 {
        C32::new(self.re - o.re, self.im - o.im)
    }
}
impl AddAssign for C32 {
    fn add_assign(&mut self, o: C32) {
        self.re += o.re;
        self.im += o.im;
    }
}
impl Mul for C32 {
    type Output = C32;
    fn mul(self, o: C32) -> C32 {
        C32::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
}
impl From<(f32, f32)> for C32 {
    fn from(p: (f32, f32)) -> Self {
        C32::new(p.0, p.1)
    }
}
