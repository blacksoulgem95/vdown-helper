//! The segment engine shared by HLS, DASH and live recording: segments are fetched in parallel and written to disk in
//! order, AES-128 decrypted where a key applies (RFC 8216), each initialisation section written once. Nothing is held
//! in memory beyond the segments in flight, so a stream of any size fits.

use std::collections::HashMap;
use std::sync::Arc;

use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use futures_util::{StreamExt, stream};
use tokio::io::AsyncWriteExt;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;
use vdh_core::hls::{HlsKey, HlsSegment, KeyMethod};

use crate::error::{EngineError, ErrorCode, Result};
use crate::net::Net;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// The largest single segment, key or initialisation section read into memory.
const MAX_SEGMENT_BYTES: usize = 512 * 1024 * 1024;

/// What is remembered between batches (a live recording appends in batches).
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkState {
    /// The initialisation section last written, so a later batch does not repeat it.
    pub map_key: String,
    /// Segments the server no longer had (HTTP 404/410) and that were left out.
    pub skipped: usize,
    /// Seconds of media written.
    pub seconds: f64,
    pub bytes: u64,
}

/// Progress of one batch: segments written, out of how many, and the sink after the last one (a checkpoint: a job can
/// continue from here after a restart).
#[derive(Debug, Clone)]
pub struct SegmentProgress {
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub state: SinkState,
}

pub struct SegmentOptions<'a> {
    pub net: &'a Net,
    pub concurrency: usize,
    /// A live stream drops old segments: one that is gone is a gap in the recording, not the end of it.
    pub tolerate_missing: bool,
    pub cancel: &'a CancellationToken,
}

/// The IV of a segment: the playlist's, or its media sequence number (RFC 8216 5.2).
fn iv_for(key: &HlsKey, sequence: f64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    if let Some(hex) = &key.iv {
        let hex = hex.trim_start_matches("0x").trim_start_matches("0X");
        let hex = format!("{hex:0>32}");
        for (i, b) in iv.iter_mut().enumerate() {
            *b = u8::from_str_radix(hex.get(i * 2..i * 2 + 2).unwrap_or("00"), 16).unwrap_or(0);
        }
    } else {
        iv[12..].copy_from_slice(&(sequence as u64 as u32).to_be_bytes());
    }
    iv
}

/// Keys fetched once per URI, shared by the segments in flight.
#[derive(Default)]
struct Keys(HashMap<String, Arc<OnceCell<[u8; 16]>>>);

impl Keys {
    fn new(segs: &[HlsSegment]) -> Self {
        let mut m = HashMap::new();
        let keys = segs
            .iter()
            .flat_map(|s| [s.key.as_ref(), s.map.as_ref().and_then(|m| m.key.as_ref())]);
        for uri in keys.flatten().filter_map(|k| k.uri.clone()) {
            m.entry(uri).or_insert_with(|| Arc::new(OnceCell::new()));
        }
        Self(m)
    }

    async fn get(&self, net: &Net, key: &HlsKey) -> Result<[u8; 16]> {
        let uri = key.uri.as_deref().ok_or_else(|| {
            EngineError::new(ErrorCode::Decrypt, "Encrypted stream without a key URI")
        })?;
        let cell = self
            .0
            .get(uri)
            .cloned()
            .unwrap_or_else(|| Arc::new(OnceCell::new()));
        cell.get_or_try_init(|| async {
            let raw = net.bytes(uri, None, 1024).await?;
            <[u8; 16]>::try_from(raw.as_slice()).map_err(|_| {
                EngineError::new(
                    ErrorCode::Decrypt,
                    "The decryption key has an unexpected size",
                )
            })
        })
        .await
        .copied()
    }
}

async fn decrypt(
    net: &Net,
    keys: &Keys,
    key: &HlsKey,
    data: Vec<u8>,
    sequence: f64,
) -> Result<Vec<u8>> {
    if key.method != KeyMethod::Aes128 {
        return Ok(data);
    }
    let k = keys.get(net, key).await?;
    Aes128CbcDec::new(&k.into(), &iv_for(key, sequence).into())
        .decrypt_padded_vec_mut::<Pkcs7>(&data)
        .map_err(|_| {
            EngineError::new(
                ErrorCode::Decrypt,
                "Failed to decrypt data (wrong key or corrupted data)",
            )
        })
}

fn gone(e: &EngineError) -> bool {
    e.code == ErrorCode::HttpError && matches!(e.message.as_str(), "HTTP 404" | "HTTP 410")
}

/// One segment, decrypted; `None` when the server no longer has it and gaps are tolerated.
async fn fetch_segment(
    net: &Net,
    keys: &Keys,
    seg: &HlsSegment,
    tolerate_missing: bool,
) -> Result<Option<Vec<u8>>> {
    let data = match net
        .bytes(&seg.uri, seg.byte_range.as_ref(), MAX_SEGMENT_BYTES)
        .await
    {
        Ok(d) => d,
        Err(e) if tolerate_missing && gone(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(Some(match &seg.key {
        Some(k) => decrypt(net, keys, k, data, seg.sequence).await?,
        None => data,
    }))
}

/// Fetch `segs` (several at a time, written in order) and append them to `out`.
pub async fn write_segments(
    opts: &SegmentOptions<'_>,
    segs: &[HlsSegment],
    out: &mut tokio::fs::File,
    state: &mut SinkState,
    mut progress: impl FnMut(SegmentProgress),
) -> Result<()> {
    let keys = Keys::new(segs);
    let net = opts.net;
    // Built up front (nothing runs until polled): a stream over a borrowing closure would not be `Send` for every
    // lifetime, which spawning the job needs.
    let fetches: Vec<_> = segs
        .iter()
        .map(|seg| fetch_segment(net, &keys, seg, opts.tolerate_missing))
        .collect();
    let fetches = stream::iter(fetches).buffered(opts.concurrency.max(1));
    tokio::pin!(fetches);

    let total = segs.len();
    let mut done = 0;
    loop {
        let next = tokio::select! {
            () = opts.cancel.cancelled() => return Err(EngineError::cancelled()),
            n = fetches.next() => n,
        };
        let Some(result) = next else { break };
        let seg = &segs[done];
        match result? {
            None => state.skipped += 1,
            Some(data) => {
                if let Some(map) = &seg.map {
                    let map_key = format!(
                        "{}|{}",
                        map.uri,
                        map.byte_range
                            .map_or(String::new(), |r| r.offset.to_string())
                    );
                    if map_key != state.map_key {
                        let mut init = net
                            .bytes(&map.uri, map.byte_range.as_ref(), MAX_SEGMENT_BYTES)
                            .await?;
                        // RFC 8216 4.3.2.5: a key in effect at the EXT-X-MAP also encrypts the initialisation section.
                        if let Some(k) = &map.key {
                            init = decrypt(net, &keys, k, init, seg.sequence).await?;
                        }
                        out.write_all(&init).await?;
                        state.bytes += init.len() as u64;
                        state.map_key = map_key;
                    }
                }
                out.write_all(&data).await?;
                state.bytes += data.len() as u64;
                state.seconds += seg.duration;
            }
        }
        done += 1;
        progress(SegmentProgress {
            done,
            total,
            bytes: state.bytes,
            state: state.clone(),
        });
    }
    out.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    fn key(iv: Option<&str>) -> HlsKey {
        HlsKey {
            method: KeyMethod::Aes128,
            uri: Some("https://a.example/k".into()),
            iv: iv.map(Into::into),
            key_format: "identity".into(),
            protected_by_drm: false,
        }
    }

    #[test]
    fn ivs_follow_rfc_8216() {
        assert_eq!(iv_for(&key(None), 7.0)[12..], [0, 0, 0, 7]);
        assert_eq!(iv_for(&key(None), 7.0)[..12], [0; 12]);
        let iv = iv_for(&key(Some("0x000102030405060708090A0B0C0D0E0F")), 7.0);
        assert_eq!(iv, std::array::from_fn::<u8, 16, _>(|i| i as u8));
        assert_eq!(iv_for(&key(Some("0x1")), 0.0)[15], 1);
    }

    #[test]
    fn aes_128_cbc_round_trip() {
        let k = [7u8; 16];
        let iv = iv_for(&key(None), 3.0);
        let clear = b"a segment that is not a multiple of sixteen bytes".to_vec();
        let enc = cbc::Encryptor::<aes::Aes128>::new(&k.into(), &iv.into())
            .encrypt_padded_vec_mut::<Pkcs7>(&clear);
        let dec = Aes128CbcDec::new(&k.into(), &iv.into())
            .decrypt_padded_vec_mut::<Pkcs7>(&enc)
            .expect("decrypts");
        assert_eq!(dec, clear);
    }
}
