//! The few strings the app shows outside its window (tray menu, notifications), from the window's own catalogs
//! (`desktop/ui/locales`), so English and Italian stay in one place.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct Entry {
    message: String,
}

type Catalog = HashMap<String, Entry>;

fn catalog(lang: &str) -> &'static Catalog {
    static EN: OnceLock<Catalog> = OnceLock::new();
    static IT: OnceLock<Catalog> = OnceLock::new();
    let (cell, text) = if lang == "it" {
        (&IT, include_str!("../../ui/locales/it.json"))
    } else {
        (&EN, include_str!("../../ui/locales/en.json"))
    };
    cell.get_or_init(|| serde_json::from_str(text).unwrap_or_default())
}

/// The language to use: the user's choice, or the system's when it is Italian, otherwise English.
pub fn resolve(choice: &str) -> &'static str {
    match choice {
        "en" => "en",
        "it" => "it",
        _ => {
            let system = sys_locale::get_locale().unwrap_or_default().to_lowercase();
            if system.starts_with("it") { "it" } else { "en" }
        }
    }
}

/// `key` in `lang`, with `$1`.. replaced by `subs`; English when the key is missing there.
pub fn t(lang: &str, key: &str, subs: &[&str]) -> String {
    let message = catalog(lang)
        .get(key)
        .or_else(|| catalog("en").get(key))
        .map_or(key, |e| e.message.as_str());
    let mut out = String::with_capacity(message.len());
    let mut chars = message.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$'
            && let Some(n) = chars.peek().and_then(|d| d.to_digit(10)).filter(|n| *n > 0)
        {
            chars.next();
            out.push_str(subs.get(n as usize - 1).copied().unwrap_or(""));
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_catalogs_have_the_native_strings() {
        for key in ["trayShow", "trayQuit", "notifyCompleted", "notifyFailed"] {
            for lang in ["en", "it"] {
                assert!(catalog(lang).contains_key(key), "{lang} {key}");
            }
        }
        assert_ne!(t("it", "trayQuit", &[]), t("en", "trayQuit", &[]));
    }

    #[test]
    fn substitutions_are_positional() {
        assert_eq!(t("en", "missing $1", &[]), "missing ");
        assert_eq!(
            t("en", "saved $1 ($2)", &["a.mp4", "1 MB"]),
            "saved a.mp4 (1 MB)"
        );
    }
}
