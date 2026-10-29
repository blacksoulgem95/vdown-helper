//! What kind of file these first bytes are, by their magic numbers (`src/lib/sniff.ts`). Used for page-held blobs, whose
//! declared type is often empty or "application/octet-stream". The bytes are only ever compared, never interpreted.

/// Bytes read as Latin-1 characters (`String.fromCharCode`).
fn ascii(b: &[u8], from: usize, len: usize) -> String {
    b.iter().skip(from).take(len).map(|&c| c as char).collect()
}

fn starts_with(b: &[u8], sig: &[u8]) -> bool {
    b.len() >= sig.len() && &b[..sig.len()] == sig
}

pub fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    if b.len() < 4 {
        return None;
    }
    let head = ascii(b, 0, 4);
    // ISO base media: "ftyp" at offset 4, the brand says what it is
    if b.len() >= 12 && ascii(b, 4, 4) == "ftyp" {
        let brand = ascii(b, 8, 4);
        return Some(match brand.as_str() {
            "qt  " => "video/quicktime",
            "M4A " | "M4B " => "audio/mp4",
            _ if brand.starts_with("3g") => "video/3gpp",
            "avif" | "avis" => "image/avif",
            "heic" | "heix" | "mif1" => "image/heic",
            _ => "video/mp4",
        });
    }
    if starts_with(b, &[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some(if ascii(b, 0, 64).contains("matroska") {
            "video/x-matroska"
        } else {
            "video/webm"
        });
    }
    match head.as_str() {
        "OggS" => return Some("audio/ogg"),
        "fLaC" => return Some("audio/flac"),
        "FLV\u{1}" => return Some("video/x-flv"),
        _ => {}
    }
    if head == "RIFF" && b.len() >= 12 {
        match ascii(b, 8, 4).as_str() {
            "WAVE" => return Some("audio/wav"),
            "AVI " => return Some("video/x-msvideo"),
            "WEBP" => return Some("image/webp"),
            _ => {}
        }
    }
    if head == "FORM" && b.len() >= 12 && ascii(b, 8, 4).starts_with("AIF") {
        return Some("audio/aiff");
    }
    if head.starts_with("ID3") {
        return Some("audio/mpeg");
    }
    let b1 = b.get(1).copied().unwrap_or(0);
    if b[0] == 0xff && (b1 & 0xe0) == 0xe0 && (b1 & 0x06) != 0 {
        return Some("audio/mpeg");
    }
    if b[0] == 0x47 && b.len() >= 376 && b.get(188) == Some(&0x47) && b.get(376) == Some(&0x47) {
        return Some("video/mp2t");
    }
    let sigs: [(&[u8], &str); 4] = [
        (
            &[0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11],
            "video/x-ms-asf",
        ),
        (&[0x89, 0x50, 0x4e, 0x47], "image/png"),
        (&[0xff, 0xd8, 0xff], "image/jpeg"),
        (&[0, 0, 1, 0], "image/x-icon"),
    ];
    for (sig, mime) in &sigs[..3] {
        if starts_with(b, sig) {
            return Some(mime);
        }
    }
    if head.starts_with("GIF8") {
        return Some("image/gif");
    }
    if head.starts_with("BM") && b.len() > 14 {
        return Some("image/bmp");
    }
    if starts_with(b, sigs[3].0) {
        return Some(sigs[3].1);
    }
    if head == "%PDF" {
        return Some("application/pdf");
    }
    if starts_with(b, &[0x50, 0x4b, 0x03, 0x04]) {
        return Some("application/zip");
    }
    if starts_with(b, &[0x1f, 0x8b]) {
        return Some("application/gzip");
    }
    if head == "Rar!" {
        return Some("application/vnd.rar");
    }
    if starts_with(b, &[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) {
        return Some("application/x-7z-compressed");
    }
    let text = ascii(b, 0, 64);
    let text = crate::js::trim_start(&text);
    if text.starts_with("WEBVTT") {
        return Some("text/vtt");
    }
    let lower = text.to_lowercase();
    let svg_tag = lower.starts_with("<svg")
        && lower[4..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || crate::js::is_js_space(c));
    if svg_tag || (lower.starts_with("<?xml") && lower.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}
