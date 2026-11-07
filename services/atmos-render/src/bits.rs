//! MSB-first bit reader over a byte slice, with EMDF's variable_bits.

pub struct Bits<'a> {
    data: &'a [u8],
    pub pos: usize,
    pub end: usize,
}

impl<'a> Bits<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0, end: data.len() * 8 }
    }
    pub fn at(data: &'a [u8], pos: usize, end: usize) -> Self {
        Self { data, pos, end }
    }
    pub fn left(&self) -> usize {
        self.end.saturating_sub(self.pos)
    }
    pub fn bit(&mut self) -> Option<bool> {
        if self.pos >= self.end {
            return None;
        }
        let b = (self.data[self.pos >> 3] >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        Some(b == 1)
    }
    pub fn read(&mut self, n: usize) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.bit()? as u32;
        }
        Some(v)
    }
    pub fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos + n > self.end {
            return None;
        }
        self.pos += n;
        Some(())
    }
    /// variable_bits(n): groups of n bits, each followed by a continue flag.
    pub fn variable(&mut self, n: usize) -> Option<u32> {
        let mut v = 0u32;
        loop {
            v += self.read(n)?;
            if !self.bit()? {
                return Some(v);
            }
            v = (v << n) + (1 << n);
        }
    }
    /// The bits from `from` to `to`, realigned to whole bytes.
    pub fn slice(data: &[u8], from: usize, to: usize) -> Vec<u8> {
        let mut r = Bits::at(data, from, to);
        let mut out = Vec::with_capacity((to - from).div_ceil(8));
        while r.left() >= 8 {
            out.push(r.read(8).unwrap() as u8);
        }
        let rest = r.left();
        if rest > 0 {
            out.push((r.read(rest).unwrap() << (8 - rest)) as u8);
        }
        out
    }
}
