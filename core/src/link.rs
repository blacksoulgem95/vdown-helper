//! Identity of the link between the extension and the desktop app (Chrome Native Messaging).

/// The extension's ID, pinned by the public `key` in `manifest.json` (see `scripts/lib/extension-id.mjs`).
pub const EXTENSION_ID: &str = "gaadncjaphdelallbigeiejgolhgoipa";

/// Native messaging host name; Chrome allows only lowercase letters, digits, `_` and `.`.
pub const HOST_NAME: &str = "io.github.blacksoulgem95.vdownhelper";

/// Version of the JSON protocol spoken over the link (`{ "v": 1, "type": ... }`).
pub const PROTOCOL_VERSION: u32 = 1;

/// The only origin the host manifest lets in.
pub fn allowed_origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

/// Whether `name` is a valid native messaging host name (`[a-z0-9_]` segments separated by single dots).
pub fn is_valid_host_name(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_name_is_valid() {
        assert!(is_valid_host_name(HOST_NAME));
        assert!(!is_valid_host_name("Io.github.x"));
        assert!(!is_valid_host_name("io..x"));
        assert!(!is_valid_host_name("io.x-y"));
        assert!(!is_valid_host_name(""));
    }

    #[test]
    fn extension_id_matches_the_build_scripts() {
        // One source of truth for the build (check:dist derives the ID from the manifest key and compares).
        let js = include_str!("../../scripts/lib/extension-id.mjs");
        assert!(js.contains(&format!("EXTENSION_ID = '{EXTENSION_ID}'")));
        assert_eq!(EXTENSION_ID.len(), 32);
        assert!(EXTENSION_ID.bytes().all(|b| (b'a'..=b'p').contains(&b)));
        assert_eq!(
            allowed_origin(),
            format!("chrome-extension://{EXTENSION_ID}/")
        );
    }
}
