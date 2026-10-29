//! Kinds of plain files besides audio/video (`src/lib/filetypes.ts`): shown in their own tabs, saved as they are.

use crate::js;
use crate::url::parse_url;

pub const FILE_KINDS: [&str; 4] = ["image", "document", "archive", "asset"];

pub fn is_file_kind(k: &str) -> bool {
    FILE_KINDS.contains(&k)
}

/// Kind by file extension (lower case, no dot).
pub fn file_kind_of_extension(ext: Option<&str>) -> Option<&'static str> {
    Some(match ext.filter(|e| !e.is_empty())? {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "svg" | "bmp" | "ico" | "tif"
        | "tiff" | "heic" | "heif" => "image",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
        | "rtf" | "txt" | "csv" | "epub" | "md" => "document",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "iso" => "archive",
        "js" | "mjs" | "css" | "woff" | "woff2" | "ttf" | "otf" | "eot" | "json" | "xml"
        | "wasm" | "webmanifest" => "asset",
        _ => return None,
    })
}

fn clean(mime: Option<&str>) -> String {
    mime.map(|m| js::trim(m.split(';').next().unwrap_or("")).to_lowercase())
        .unwrap_or_default()
}

fn mime_ext(m: &str) -> Option<&'static str> {
    Some(match m {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/tiff" => "tif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "application/pdf" => "pdf",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/vnd.oasis.opendocument.text" => "odt",
        "application/vnd.oasis.opendocument.spreadsheet" => "ods",
        "application/vnd.oasis.opendocument.presentation" => "odp",
        "application/rtf" => "rtf",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "application/epub+zip" => "epub",
        "text/markdown" => "md",
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/vnd.rar" | "application/x-rar-compressed" => "rar",
        "application/x-7z-compressed" => "7z",
        "application/x-tar" => "tar",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/x-bzip2" => "bz2",
        "application/x-xz" => "xz",
        "application/zstd" => "zst",
        "application/x-iso9660-image" => "iso",
        "text/css" => "css",
        "text/javascript" | "application/javascript" | "application/x-javascript" => "js",
        "font/woff" | "application/font-woff" => "woff",
        "font/woff2" => "woff2",
        "font/ttf" => "ttf",
        "font/otf" => "otf",
        "application/json" => "json",
        "application/xml" | "text/xml" => "xml",
        "application/wasm" => "wasm",
        "application/manifest+json" => "webmanifest",
        _ => return None,
    })
}

/// File extension for a MIME type, when it is one we know.
pub fn extension_for_mime(mime: Option<&str>) -> Option<&'static str> {
    mime_ext(&clean(mime))
}

/// Kind by MIME type. Any image/* counts as an image, even a type not listed.
pub fn file_kind_of_mime(mime: Option<&str>) -> Option<&'static str> {
    let m = clean(mime);
    if m.is_empty() {
        return None;
    }
    if m.starts_with("image/") {
        return Some("image");
    }
    match mime_ext(&m) {
        Some(ext) => file_kind_of_extension(Some(ext)),
        None => m.starts_with("font/").then_some("asset"),
    }
}

/// Lower-case extension of a URL's path (`""` when there is none or it does not look like one).
pub fn url_extension(url: &str) -> String {
    let Some(u) = parse_url(url, None) else {
        return String::new();
    };
    let last = u.path().rsplit('/').next().unwrap_or("");
    let ext = last
        .rfind('.')
        .map_or_else(String::new, |d| last[d + 1..].to_lowercase());
    let ok = (1..=8).contains(&ext.len())
        && ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if ok { ext } else { String::new() }
}

/// The file name as the server names it, without extension and decoded: "photo-1" for ".../a/photo-1.jpg?x=1".
pub fn file_stem(url: &str) -> String {
    let Some(u) = parse_url(url, None) else {
        return String::new();
    };
    let raw = u.path().split('/').rfind(|s| !s.is_empty()).unwrap_or("");
    let last = js::decode_uri_component(raw).unwrap_or_else(|| raw.to_string());
    // `.replace(/\.[a-z0-9]{1,8}$/i, '')`
    let stem = match last.rfind('.') {
        Some(d) => {
            let ext = &last[d + 1..];
            if (1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
                &last[..d]
            } else {
                &last
            }
        }
        None => &last,
    };
    js::trim(stem).to_string()
}
