//! The process the browser starts (`chrome-extension://…` on its command line). It connects to the running app's local
//! socket, starting the app (in the tray) first when it is not running, and passes the extension's frames through in
//! both directions until either side closes. The browser only ever owns this relay: closing the browser ends the relay,
//! never the app or its jobs.

use std::io;
use std::time::{Duration, Instant};

use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::tokio::prelude::*;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The browser starts a native host with the calling extension's origin as an argument.
pub fn launched_by_browser(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|a| a.starts_with("chrome-extension://"))
}

/// Relay until either side closes; the process's exit code.
pub fn run() -> i32 {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(rt) = rt else {
        return 1;
    };
    match rt.block_on(relay()) {
        Ok(()) => 0,
        Err(e) => {
            // stderr goes to the browser's log; there is nothing else to say it to
            eprintln!("vdown-helper relay: {e}");
            1
        }
    }
}

async fn connect() -> io::Result<Stream> {
    if let Ok(s) = Stream::connect(super::socket_name()?).await {
        return Ok(s);
    }
    start_app()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        match Stream::connect(super::socket_name()?).await {
            Ok(s) => return Ok(s),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => {}
        }
    }
}

/// Start the app in the tray, detached from the relay (and from the browser's process group or job), so it keeps
/// running when the browser closes.
fn start_app() -> io::Result<()> {
    let exe = super::host::program()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the app's own path"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(crate::HIDDEN)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        // the browser's job does not allow breaking away: start it inside it
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(drop)
}

async fn relay() -> io::Result<()> {
    let stream = connect().await?;
    let (mut from_app, mut to_app) = (&stream, &stream);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        r = pump(&mut stdin, &mut to_app) => r,
        r = pump(&mut from_app, &mut stdout) => r,
    }
}

async fn pump<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(r: &mut R, w: &mut W) -> io::Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        w.write_all(&buf[..n]).await?;
        w.flush().await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_browser_launch_is_a_relay() {
        let args = |a: &[&str]| a.iter().map(ToString::to_string).collect::<Vec<_>>();
        assert!(launched_by_browser(&args(&[
            "app",
            "chrome-extension://abc/"
        ])));
        assert!(launched_by_browser(&args(&[
            "app.exe",
            "chrome-extension://abc/",
            "--parent-window=0"
        ])));
        assert!(!launched_by_browser(&args(&["app"])));
        assert!(!launched_by_browser(&args(&["app", "--hidden"])));
        assert!(!launched_by_browser(&args(&["chrome-extension://abc/"])));
    }
}
