//! Which video encoders work on this machine: the software ones ffmpeg was built with, and the hardware ones (NVENC,
//! Quick Sync, AMF, VideoToolbox, VAAPI) that also pass a one-frame test encode (ffmpeg lists them whether or not a
//! device and driver are there).

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use vdh_core::transcode::{CODECS, Encoder, HARDWARE, VideoCodec, encoder_name, test_encode_args};

use crate::ffmpeg::ffmpeg_program;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub codec: VideoCodec,
    pub encoder: Encoder,
    /// ffmpeg's name for it (`libx265`, `h264_nvenc`...).
    pub name: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Encoders {
    pub video: Vec<Available>,
    pub aac: bool,
    pub opus: bool,
}

/// The encoder names in `ffmpeg -encoders` output.
pub fn listed(text: &str) -> Vec<&str> {
    text.lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            let flags = words.next()?;
            // " V....D libx264  ..." / " A....D aac ..."
            let name = words.next()?;
            // the legend at the top (" V..... = Video") is not an encoder
            (flags.len() == 6 && flags.starts_with(['V', 'A']) && name != "=").then_some(name)
        })
        .collect()
}

async fn works(codec: VideoCodec, encoder: Encoder) -> bool {
    let Some(args) = test_encode_args(codec, encoder) else {
        return false;
    };
    let run = Command::new(ffmpeg_program())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    matches!(tokio::time::timeout(Duration::from_secs(20), run).await, Ok(Ok(s)) if s.success())
}

/// What this machine can encode. Software encoders count when ffmpeg lists them; hardware ones after a test encode.
pub async fn detect() -> Encoders {
    let out = Command::new(ffmpeg_program())
        .args(["-hide_banner", "-encoders"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    let Ok(out) = out else {
        return Encoders::default();
    };
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let names = listed(&text);
    let mut video = Vec::new();
    for codec in CODECS {
        for encoder in std::iter::once(Encoder::Software).chain(HARDWARE) {
            let Some(name) = encoder_name(codec, encoder) else {
                continue;
            };
            if !names.contains(&name) {
                continue;
            }
            if encoder == Encoder::Software || works(codec, encoder).await {
                video.push(Available {
                    codec,
                    encoder,
                    name,
                });
            }
        }
    }
    Encoders {
        video,
        aac: names.contains(&"aac"),
        opus: names.contains(&"libopus"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoder_list_is_read_from_ffmpegs_table() {
        let text = "Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n \
                    V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n A....D aac   AAC\n \
                    S..... srt  SubRip subtitle\n";
        assert_eq!(listed(text), ["libx264", "h264_nvenc", "aac"]);
    }
}
