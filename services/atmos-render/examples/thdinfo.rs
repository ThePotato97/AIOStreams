//! Diagnostic: prints a TrueHD stream's dialnorm per presentation from its first major sync.
use truehd::process::extract::Extractor;
use truehd::process::parse::Parser;
fn main() {
    let path = std::env::args().nth(1).expect("path");
    let data = std::fs::read(path).unwrap();
    let mut ex = Extractor::default();
    ex.push_bytes(&data[..data.len().min(1 << 20)]);
    let mut parser = Parser::default();
    while let Some(f) = ex.next() {
        let Ok(f) = f else { continue };
        if !f.is_major_sync() {
            continue;
        }
        let Some(au) = parser.parse_recovering(&f) else { continue };
        if let Some(cm) = au.major_sync_info.as_ref().and_then(|m| m.channel_meaning.fba()) {
            let sixteen = cm.extra_channel_meaning.as_ref().map(|e| e.sixteench_dialogue_norm);
            println!("dialnorm 2ch {} 6ch {} 8ch {} 16ch {:?}", cm.twoch_dialogue_norm, cm.sixch_dialogue_norm, cm.eightch_dialogue_norm, sixteen);
            return;
        }
    }
    println!("no FBA major sync found");
}
