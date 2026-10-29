//! ZIP planning from `src/lib/zip.ts`: which resources go in, under which names, and which are worth compressing.

use serde::Serialize;
use serde_json::Value;

use crate::obj::{str_of, truthy};
use crate::security::{sanitize_filename, with_extension};

/// The most files one ZIP may hold.
pub const MAX_ZIP_ITEMS: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct ZipItem {
    pub url: String,
    /// Name inside the archive: flat, sanitised, unique (case-insensitively, as extraction tools see it).
    pub name: String,
    pub deflate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZipPlan {
    pub items: Vec<ZipItem>,
    /// Resources left out (page-held, not downloadable, or over the limit).
    pub left: usize,
}

/// Text-like files compress well; images, archives, fonts and PDFs are already compressed, so they are stored.
pub fn should_deflate(ext: Option<&str>) -> bool {
    matches!(
        ext.unwrap_or("").to_lowercase().as_str(),
        "css"
            | "js"
            | "mjs"
            | "json"
            | "xml"
            | "svg"
            | "txt"
            | "csv"
            | "md"
            | "wasm"
            | "webmanifest"
            | "rtf"
    )
}

/// The file name as the server gives it, made safe, and made unique by " (2)", " (3)" before the extension.
pub fn zip_entry_names<'a>(
    items: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Vec<String> {
    let mut taken: Vec<String> = Vec::new();
    items
        .into_iter()
        .map(|(title, ext)| {
            let ext = ext.unwrap_or("");
            let stem = sanitize_filename(title, "file", 120);
            let named = |s: &str| {
                if ext.is_empty() {
                    s.to_string()
                } else {
                    with_extension(s, ext)
                }
            };
            let mut name = named(&stem);
            let mut n = 2;
            while taken.contains(&name.to_lowercase()) {
                name = named(&format!("{stem} ({n})"));
                n += 1;
            }
            taken.push(name.to_lowercase());
            name
        })
        .collect()
}

/// Entries for the given resources: page-held data and anything not downloadable are left out.
pub fn plan_zip(resources: &[Value]) -> ZipPlan {
    let picked: Vec<&Value> = resources
        .iter()
        .filter(|r| {
            !truthy(r.get("held"))
                && r.get("downloadability").and_then(|d| str_of(d, "status"))
                    == Some("downloadable")
        })
        .take(MAX_ZIP_ITEMS)
        .collect();
    let names = zip_entry_names(picked.iter().map(|r| {
        (
            str_of(r, "title").unwrap_or(""),
            str_of(r, "ext").filter(|e| !e.is_empty()),
        )
    }));
    ZipPlan {
        items: picked
            .iter()
            .zip(names)
            .map(|(r, name)| ZipItem {
                url: str_of(r, "url").unwrap_or("").to_string(),
                name,
                deflate: should_deflate(str_of(r, "ext")),
            })
            .collect(),
        left: resources.len() - picked.len(),
    }
}
