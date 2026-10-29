//! Chrome's native messaging framing: a 4-byte length (native byte order, little-endian on every platform the app
//! ships for) followed by that many bytes of UTF-8 JSON. The relay passes frames through unchanged; the app reads and
//! writes them on the local socket.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// What the browser may send in one message (Chrome's own limit).
pub const MAX_FROM_BROWSER: usize = 64 * 1024 * 1024;
/// What the app may send in one message (Chrome refuses more than 1 MB).
pub const MAX_TO_BROWSER: usize = 1024 * 1024;

/// The next message, or `None` when the other side closed the connection between messages.
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FROM_BROWSER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(Some(body))
}

pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_TO_BROWSER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let len = u32::try_from(body.len()).map_err(|_| io::ErrorKind::InvalidData)?;
    w.write_all(&len.to_le_bytes()).await?;
    w.write_all(body).await?;
    w.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_end_cleanly() {
        let mut buf = Vec::new();
        write(&mut buf, br#"{"v":1}"#).await.expect("write");
        write(&mut buf, b"{}").await.expect("write");
        assert_eq!(&buf[..4], &7u32.to_le_bytes());
        let mut r = buf.as_slice();
        assert_eq!(
            read(&mut r).await.expect("read").as_deref(),
            Some(&br#"{"v":1}"#[..])
        );
        assert_eq!(
            read(&mut r).await.expect("read").as_deref(),
            Some(&b"{}"[..])
        );
        assert_eq!(read(&mut r).await.expect("end"), None);
    }

    #[tokio::test]
    async fn oversized_and_truncated_messages_are_errors() {
        let mut r: &[u8] = &(u32::MAX).to_le_bytes();
        assert!(read(&mut r).await.is_err());
        let mut cut = 10u32.to_le_bytes().to_vec();
        cut.extend_from_slice(b"abc");
        let mut r = cut.as_slice();
        assert!(read(&mut r).await.is_err());
        let mut out = Vec::new();
        assert!(
            write(&mut out, &vec![b' '; MAX_TO_BROWSER + 1])
                .await
                .is_err()
        );
    }
}
