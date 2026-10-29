//! The native messaging host registration: a small JSON manifest that tells each Chromium-family browser where the app
//! is and that only vdown-helper's extension may start it. Written for the current user at every launch (so a moved
//! app repairs itself) and from Settings ("Repair browser link").

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

pub const HOST_NAME: &str = "io.github.blacksoulgem95.vdownhelper";
/// The extension's ID, pinned by the `key` in its manifest (store and unpacked installs share it).
pub const EXTENSION_ORIGIN: &str = "chrome-extension://jplegcfjmgefcabmhljkgneehmgfhclk/";

// each platform reads only its own column
#[allow(dead_code)]
pub struct Browser {
    pub name: &'static str,
    /// Under `HKCU\Software\`.
    pub windows: &'static str,
    /// Under `~/Library/Application Support/`.
    pub macos: &'static str,
    /// Under `~/.config/`.
    pub linux: &'static str,
}

pub const BROWSERS: [Browser; 6] = [
    Browser {
        name: "Chrome",
        windows: r"Google\Chrome",
        macos: "Google/Chrome",
        linux: "google-chrome",
    },
    Browser {
        name: "Chromium",
        windows: "Chromium",
        macos: "Chromium",
        linux: "chromium",
    },
    Browser {
        name: "Edge",
        windows: r"Microsoft\Edge",
        macos: "Microsoft Edge",
        linux: "microsoft-edge",
    },
    Browser {
        name: "Brave",
        windows: r"BraveSoftware\Brave-Browser",
        macos: "BraveSoftware/Brave-Browser",
        linux: "BraveSoftware/Brave-Browser",
    },
    Browser {
        name: "Vivaldi",
        windows: "Vivaldi",
        macos: "Vivaldi",
        linux: "vivaldi",
    },
    Browser {
        name: "Opera",
        windows: "Opera Software",
        macos: "com.operasoftware.Opera",
        linux: "opera",
    },
];

/// Where the browser registered the host (a manifest file, or the registry key on Windows).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    pub browser: &'static str,
    pub location: String,
}

/// The program the browser starts: the AppImage itself when the app runs from one (its mount moves at every launch).
pub fn program() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
}

pub fn manifest(program: &Path) -> Value {
    json!({
        "name": HOST_NAME,
        "description": "vdown-helper desktop app",
        "path": program,
        "type": "stdio",
        "allowed_origins": [EXTENSION_ORIGIN],
    })
}

/// Write the manifest into `base/<browser>/NativeMessagingHosts/` for every browser whose folder exists under `base`
/// (a browser that is not installed is left alone).
#[cfg_attr(windows, allow(dead_code))]
pub fn register_under(
    base: &Path,
    program: &Path,
    folder: impl Fn(&Browser) -> &'static str,
) -> Vec<Registered> {
    let text = serde_json::to_string_pretty(&manifest(program)).unwrap_or_default();
    let mut done = Vec::new();
    for b in &BROWSERS {
        let dir = base.join(folder(b));
        if !dir.is_dir() {
            continue;
        }
        let hosts = dir.join("NativeMessagingHosts");
        let file = hosts.join(format!("{HOST_NAME}.json"));
        let wrote = std::fs::create_dir_all(&hosts).and_then(|()| std::fs::write(&file, &text));
        if wrote.is_ok() {
            done.push(Registered {
                browser: b.name,
                location: file.to_string_lossy().into_owned(),
            });
        }
    }
    done
}

/// Register the app with every browser found for the current user.
#[cfg(target_os = "linux")]
pub fn register(program: &Path, _data_dir: &Path) -> Vec<Registered> {
    dirs::config_dir().map_or_else(Vec::new, |base| register_under(&base, program, |b| b.linux))
}

#[cfg(target_os = "macos")]
pub fn register(program: &Path, _data_dir: &Path) -> Vec<Registered> {
    dirs::data_dir().map_or_else(Vec::new, |base| register_under(&base, program, |b| b.macos))
}

/// Windows reads the manifest's location from the registry: the manifest lives in the app's data folder and every
/// browser gets a key pointing at it.
#[cfg(windows)]
pub fn register(program: &Path, data_dir: &Path) -> Vec<Registered> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let file = data_dir.join("native-host.json");
    let text = serde_json::to_string_pretty(&manifest(program)).unwrap_or_default();
    if std::fs::create_dir_all(data_dir)
        .and_then(|()| std::fs::write(&file, text))
        .is_err()
    {
        return Vec::new();
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut done = Vec::new();
    for b in &BROWSERS {
        let key = format!(r"Software\{}\NativeMessagingHosts\{HOST_NAME}", b.windows);
        if let Ok((k, _)) = hkcu.create_subkey(&key)
            && k.set_value("", &file.to_string_lossy().into_owned())
                .is_ok()
        {
            done.push(Registered {
                browser: b.name,
                location: format!(r"HKCU\{key}"),
            });
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_names_the_host_the_program_and_only_the_extension() {
        let m = manifest(Path::new("/opt/vdown-helper/vdown-helper"));
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], "/opt/vdown-helper/vdown-helper");
        assert_eq!(m["allowed_origins"], json!([EXTENSION_ORIGIN]));
    }

    #[test]
    fn only_installed_browsers_are_registered() {
        let base = std::env::temp_dir().join(format!("vdh-host-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("chromium")).expect("chromium");
        std::fs::create_dir_all(base.join("BraveSoftware/Brave-Browser")).expect("brave");
        let done = register_under(&base, Path::new("/bin/app"), |b| b.linux);
        let names: Vec<_> = done.iter().map(|r| r.browser).collect();
        assert_eq!(names, ["Chromium", "Brave"]);
        let file = base.join(format!("chromium/NativeMessagingHosts/{HOST_NAME}.json"));
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(file).expect("written")).expect("json");
        assert_eq!(written["path"], "/bin/app");
        assert!(
            !base.join("google-chrome").exists(),
            "a missing browser got a folder"
        );
        // again: the same files, rewritten (a moved app repairs itself)
        assert_eq!(
            register_under(&base, Path::new("/bin/app2"), |b| b.linux).len(),
            2
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
