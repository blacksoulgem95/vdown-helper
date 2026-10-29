//! The link with the browser extension (Chrome native messaging). The browser starts the app's binary as a relay
//! (`relay`), which passes the extension's messages to the running app over a local socket that only the current user
//! can open, starting the app first when needed; so the browser only ever owns the relay, and jobs outlive it. The app
//! side (`server`) speaks protocol v1 (`protocol`). Design: `docs/desktop.md`.

pub mod frame;
pub mod host;
pub mod protocol;
pub mod relay;
pub mod server;

use std::io;
#[cfg(unix)]
use std::path::PathBuf;

use interprocess::local_socket::Name;

/// The app's identifier: its data folder, and Tauri's.
#[cfg(unix)]
pub const IDENTIFIER: &str = "io.github.blacksoulgem95.vdownhelper";

/// The app's data folder (the same one Tauri uses), where the Unix socket lives.
#[cfg(unix)]
pub fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(IDENTIFIER))
}

/// The local socket: a file in a folder only the user can enter (Unix), or a named pipe (Windows), whose default
/// security lets only its creator write to it.
#[cfg(unix)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::{GenericFilePath, ToFsName};
    let dir = data_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?
        .join("link");
    dir.join("socket").to_fs_name::<GenericFilePath>()
}

#[cfg(windows)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::{GenericNamespaced, ToNsName};
    let user = std::env::var("USERNAME").unwrap_or_default();
    let user: String = user.chars().filter(char::is_ascii_alphanumeric).collect();
    format!("vdown-helper-link-{user}").to_ns_name::<GenericNamespaced>()
}

/// The folder of the socket, created for the user only.
#[cfg(unix)]
pub fn prepare_socket_dir() -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = data_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data folder"))?
        .join("link");
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
pub fn prepare_socket_dir() -> io::Result<()> {
    Ok(())
}
