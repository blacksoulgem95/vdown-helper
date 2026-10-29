//! Re-encoding, for the desktop app only (the extension never re-encodes video). A closed set of operations: a container,
//! a video codec with the encoder that makes it (software, or a hardware encoder the app found working), a quality or a
//! bitrate, an optional size cap and the audio. Combinations a container cannot hold are refused before anything runs;
//! the result is an ffmpeg argument vector, never a shell line.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mkv,
    Webm,
}

impl Container {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mkv => "mkv",
            Self::Webm => "webm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
    Vp9,
    /// The video as it is (only the audio, the size cap is then not possible, or the container change).
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    Software,
    Nvenc,
    Qsv,
    Amf,
    Videotoolbox,
    Vaapi,
}

pub const HARDWARE: [Encoder; 5] = [
    Encoder::Nvenc,
    Encoder::Qsv,
    Encoder::Amf,
    Encoder::Videotoolbox,
    Encoder::Vaapi,
];
pub const CODECS: [VideoCodec; 4] = [
    VideoCodec::H264,
    VideoCodec::H265,
    VideoCodec::Av1,
    VideoCodec::Vp9,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Quality {
    /// Constant quality, 0 (best) to 51 (smallest), as x264's CRF; each encoder gets its own equivalent.
    Crf { value: u8 },
    /// Average bitrate in kbit/s.
    Bitrate { kbps: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "codec", rename_all = "lowercase")]
pub enum Audio {
    Copy,
    Aac { kbps: u32 },
    Opus { kbps: u32 },
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Encode {
    pub container: Container,
    pub codec: VideoCodec,
    pub encoder: Encoder,
    pub quality: Quality,
    /// Scale down to this height (keeping the shape); never up. `None`: keep the size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u32>,
    pub audio: Audio,
}

/// The ffmpeg encoder that makes `codec` with `encoder`, when there is one.
pub fn encoder_name(codec: VideoCodec, encoder: Encoder) -> Option<&'static str> {
    use Encoder as E;
    use VideoCodec as C;
    Some(match (codec, encoder) {
        (C::H264, E::Software) => "libx264",
        (C::H264, E::Nvenc) => "h264_nvenc",
        (C::H264, E::Qsv) => "h264_qsv",
        (C::H264, E::Amf) => "h264_amf",
        (C::H264, E::Videotoolbox) => "h264_videotoolbox",
        (C::H264, E::Vaapi) => "h264_vaapi",
        (C::H265, E::Software) => "libx265",
        (C::H265, E::Nvenc) => "hevc_nvenc",
        (C::H265, E::Qsv) => "hevc_qsv",
        (C::H265, E::Amf) => "hevc_amf",
        (C::H265, E::Videotoolbox) => "hevc_videotoolbox",
        (C::H265, E::Vaapi) => "hevc_vaapi",
        (C::Av1, E::Software) => "libsvtav1",
        (C::Av1, E::Nvenc) => "av1_nvenc",
        (C::Av1, E::Qsv) => "av1_qsv",
        (C::Av1, E::Amf) => "av1_amf",
        (C::Av1, E::Vaapi) => "av1_vaapi",
        (C::Vp9, E::Software) => "libvpx-vp9",
        (C::Vp9, E::Qsv) => "vp9_qsv",
        (C::Vp9, E::Vaapi) => "vp9_vaapi",
        _ => return None,
    })
}

/// A short name for an encode, the same in every language (`H.265 720p`, `H.264 NVENC`, `MKV`): what a re-encoded file
/// is called after when it is not one of the presets.
pub fn label(e: &Encode) -> String {
    let mut parts = vec![match e.codec {
        VideoCodec::H264 => "H.264".to_string(),
        VideoCodec::H265 => "H.265".to_string(),
        VideoCodec::Av1 => "AV1".to_string(),
        VideoCodec::Vp9 => "VP9".to_string(),
        VideoCodec::Copy => e.container.extension().to_uppercase(),
    }];
    if let Some(h) = e.max_height {
        parts.push(format!("{h}p"));
    }
    if e.codec != VideoCodec::Copy {
        let hw = match e.encoder {
            Encoder::Software => None,
            Encoder::Nvenc => Some("NVENC"),
            Encoder::Qsv => Some("QSV"),
            Encoder::Amf => Some("AMF"),
            Encoder::Videotoolbox => Some("VideoToolbox"),
            Encoder::Vaapi => Some("VAAPI"),
        };
        parts.extend(hw.map(String::from));
    }
    parts.join(" ")
}

/// The render node VAAPI encoders use.
pub const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

/// Why an encode cannot be done as asked (a stable code; the app shows it in the user's language).
pub fn check(e: &Encode) -> Result<(), &'static str> {
    if e.codec != VideoCodec::Copy && encoder_name(e.codec, e.encoder).is_none() {
        return Err("encoder-codec");
    }
    if e.codec == VideoCodec::Copy && e.max_height.is_some() {
        return Err("copy-resize");
    }
    match e.quality {
        Quality::Crf { value } if value > 51 => return Err("quality"),
        Quality::Bitrate { kbps } if !(100..=200_000).contains(&kbps) => return Err("bitrate"),
        _ => {}
    }
    if e.max_height.is_some_and(|h| !(144..=4320).contains(&h)) {
        return Err("size");
    }
    let audio_kbps = match e.audio {
        Audio::Aac { kbps } | Audio::Opus { kbps } => Some(kbps),
        _ => None,
    };
    if audio_kbps.is_some_and(|k| !(32..=512).contains(&k)) {
        return Err("audio-bitrate");
    }
    // what each container can hold (Matroska holds them all)
    match e.container {
        Container::Mp4 if e.codec == VideoCodec::Vp9 => Err("container-codec"),
        Container::Mp4 if matches!(e.audio, Audio::Opus { .. }) => Err("container-audio"),
        Container::Webm if matches!(e.codec, VideoCodec::H264 | VideoCodec::H265) => {
            Err("container-codec")
        }
        Container::Webm if matches!(e.audio, Audio::Aac { .. }) => Err("container-audio"),
        _ => Ok(()),
    }
}

fn quality_args(name: &str, q: Quality) -> Vec<String> {
    let v = |xs: &[&str]| xs.iter().map(|x| (*x).to_string()).collect::<Vec<_>>();
    match q {
        Quality::Bitrate { kbps } => {
            let b = format!("{kbps}k");
            match name {
                "libx265" | "libx264" | "libsvtav1" | "libvpx-vp9" => v(&["-b:v", &b]),
                // hardware encoders: an average with room for peaks
                _ => {
                    let max = format!("{}k", kbps.saturating_mul(2));
                    v(&["-b:v", &b, "-maxrate", &max])
                }
            }
        }
        Quality::Crf { value } => {
            let n = value.to_string();
            match name {
                "libx264" | "libx265" => v(&["-crf", &n, "-preset", "medium"]),
                "libsvtav1" => v(&["-crf", &n, "-preset", "8"]),
                // constant quality needs a zero bitrate with libvpx
                "libvpx-vp9" => v(&["-crf", &n, "-b:v", "0", "-row-mt", "1"]),
                n2 if n2.ends_with("_nvenc") => v(&["-rc", "vbr", "-cq", &n, "-b:v", "0"]),
                n2 if n2.ends_with("_qsv") => v(&["-global_quality", &n]),
                n2 if n2.ends_with("_amf") => v(&["-rc", "cqp", "-qp_i", &n, "-qp_p", &n]),
                n2 if n2.ends_with("_vaapi") => v(&["-rc_mode", "CQP", "-qp", &n]),
                // VideoToolbox: 1..100, higher is better
                _ => {
                    let q = (100u32.saturating_sub(u32::from(value) * 2)).clamp(1, 100);
                    v(&["-q:v", &q.to_string()])
                }
            }
        }
    }
}

/// The ffmpeg arguments that re-encode `input` into `output` as `e` says. `progress`: report on stdout.
pub fn build_encode_args(
    input: &str,
    output: &str,
    e: &Encode,
    progress: bool,
) -> Result<Vec<String>, &'static str> {
    check(e)?;
    let s = |x: &str| x.to_string();
    let mut args = vec![s("-hide_banner"), s("-y")];
    if progress {
        args.extend([s("-nostats"), s("-progress"), s("pipe:1")]);
    }
    let vaapi = e.codec != VideoCodec::Copy && e.encoder == Encoder::Vaapi;
    if vaapi {
        args.extend([s("-vaapi_device"), s(VAAPI_DEVICE)]);
    }
    args.extend([s("-i"), s(input), s("-map"), s("0:v:0")]);
    if e.audio != Audio::None {
        args.extend([s("-map"), s("0:a:0?")]);
    }
    if e.codec == VideoCodec::Copy {
        args.extend([s("-c:v"), s("copy")]);
    } else {
        let name = encoder_name(e.codec, e.encoder).ok_or("encoder-codec")?;
        let mut filters = Vec::new();
        if let Some(h) = e.max_height {
            // never upscale; an even width keeps every encoder happy
            filters.push(format!("scale=-2:min(ih\\,{h})"));
        }
        if vaapi {
            filters.push(s("format=nv12"));
            filters.push(s("hwupload"));
        }
        if !filters.is_empty() {
            args.extend([s("-vf"), filters.join(",")]);
        }
        args.extend([s("-c:v"), s(name)]);
        args.extend(quality_args(name, e.quality));
        if e.codec == VideoCodec::H265 && e.container == Container::Mp4 {
            // the tag Apple's players expect
            args.extend([s("-tag:v"), s("hvc1")]);
        }
        if e.encoder == Encoder::Software && matches!(e.codec, VideoCodec::H264 | VideoCodec::H265)
        {
            // 8-bit 4:2:0: what every player decodes
            args.extend([s("-pix_fmt"), s("yuv420p")]);
        }
    }
    match e.audio {
        Audio::Copy => args.extend([s("-c:a"), s("copy")]),
        Audio::Aac { kbps } => args.extend([s("-c:a"), s("aac"), s("-b:a"), format!("{kbps}k")]),
        Audio::Opus { kbps } => {
            args.extend([s("-c:a"), s("libopus"), s("-b:a"), format!("{kbps}k")]);
        }
        Audio::None => args.push(s("-an")),
    }
    args.push(s("-sn"));
    if e.container == Container::Mp4 {
        args.extend([s("-movflags"), s("+faststart")]);
    }
    args.push(s(output));
    Ok(args)
}

/// A one-frame encode of a test picture: whether `codec` with `encoder` works on this machine (a hardware encoder can be
/// listed by ffmpeg and still have no device or driver behind it).
pub fn test_encode_args(codec: VideoCodec, encoder: Encoder) -> Option<Vec<String>> {
    let name = encoder_name(codec, encoder)?;
    let s = |x: &str| x.to_string();
    let mut args = vec![s("-hide_banner"), s("-v"), s("error")];
    if encoder == Encoder::Vaapi {
        args.extend([s("-vaapi_device"), s(VAAPI_DEVICE)]);
    }
    args.extend([
        s("-f"),
        s("lavfi"),
        s("-i"),
        s("color=c=black:s=320x240:r=25:d=0.2"),
        s("-frames:v"),
        s("2"),
    ]);
    if encoder == Encoder::Vaapi {
        args.extend([s("-vf"), s("format=nv12,hwupload")]);
    }
    args.extend([s("-c:v"), s(name), s("-f"), s("null"), s("-")]);
    Some(args)
}

/// A named starting point; every field can still be changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: &'static str,
    pub encode: Encode,
}

pub const PRESETS: [Preset; 5] = [
    // plays everywhere
    Preset {
        id: "compatible",
        encode: Encode {
            container: Container::Mp4,
            codec: VideoCodec::H264,
            encoder: Encoder::Software,
            quality: Quality::Crf { value: 20 },
            max_height: Some(1080),
            audio: Audio::Aac { kbps: 160 },
        },
    },
    // about half the size of H.264 at the same look
    Preset {
        id: "smaller",
        encode: Encode {
            container: Container::Mp4,
            codec: VideoCodec::H265,
            encoder: Encoder::Software,
            quality: Quality::Crf { value: 26 },
            max_height: None,
            audio: Audio::Aac { kbps: 128 },
        },
    },
    Preset {
        id: "phone",
        encode: Encode {
            container: Container::Mp4,
            codec: VideoCodec::H264,
            encoder: Encoder::Software,
            quality: Quality::Crf { value: 23 },
            max_height: Some(720),
            audio: Audio::Aac { kbps: 128 },
        },
    },
    Preset {
        id: "web",
        encode: Encode {
            container: Container::Webm,
            codec: VideoCodec::Vp9,
            encoder: Encoder::Software,
            quality: Quality::Crf { value: 32 },
            max_height: Some(1080),
            audio: Audio::Opus { kbps: 128 },
        },
    },
    Preset {
        id: "archive",
        encode: Encode {
            container: Container::Mkv,
            codec: VideoCodec::Av1,
            encoder: Encoder::Software,
            quality: Quality::Crf { value: 30 },
            max_height: None,
            audio: Audio::Opus { kbps: 128 },
        },
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(container: Container, codec: VideoCodec, encoder: Encoder) -> Encode {
        Encode {
            container,
            codec,
            encoder,
            quality: Quality::Crf { value: 23 },
            max_height: None,
            audio: Audio::Aac { kbps: 128 },
        }
    }

    #[test]
    fn every_preset_is_a_valid_encode() {
        for p in PRESETS {
            assert_eq!(check(&p.encode), Ok(()), "{}", p.id);
            assert!(build_encode_args("in.mp4", "out", &p.encode, false).is_ok());
        }
    }

    #[test]
    fn an_encode_has_a_short_name() {
        let mut e = enc(Container::Mkv, VideoCodec::H265, Encoder::Software);
        assert_eq!(label(&e), "H.265");
        e.max_height = Some(720);
        e.encoder = Encoder::Nvenc;
        assert_eq!(label(&e), "H.265 720p NVENC");
        let copy = enc(Container::Mkv, VideoCodec::Copy, Encoder::Nvenc);
        assert_eq!(label(&copy), "MKV");
    }

    #[test]
    fn containers_refuse_what_they_cannot_hold() {
        use Container as K;
        use VideoCodec as C;
        assert_eq!(
            check(&enc(K::Mp4, C::Vp9, Encoder::Software)),
            Err("container-codec")
        );
        assert_eq!(
            check(&enc(K::Webm, C::H264, Encoder::Software)),
            Err("container-codec")
        );
        let mut opus_mp4 = enc(K::Mp4, C::H264, Encoder::Software);
        opus_mp4.audio = Audio::Opus { kbps: 128 };
        assert_eq!(check(&opus_mp4), Err("container-audio"));
        let mut aac_webm = enc(K::Webm, C::Vp9, Encoder::Software);
        assert_eq!(check(&aac_webm), Err("container-audio"));
        aac_webm.audio = Audio::Opus { kbps: 128 };
        assert_eq!(check(&aac_webm), Ok(()));
        // Matroska holds them all
        for c in CODECS {
            assert_eq!(check(&enc(K::Mkv, c, Encoder::Software)), Ok(()), "{c:?}");
        }
    }

    #[test]
    fn out_of_range_values_and_impossible_encoders_are_refused() {
        let mut e = enc(Container::Mkv, VideoCodec::H264, Encoder::Software);
        e.quality = Quality::Crf { value: 60 };
        assert_eq!(check(&e), Err("quality"));
        e.quality = Quality::Bitrate { kbps: 10 };
        assert_eq!(check(&e), Err("bitrate"));
        e.quality = Quality::Crf { value: 20 };
        e.max_height = Some(10);
        assert_eq!(check(&e), Err("size"));
        assert_eq!(
            check(&enc(Container::Mkv, VideoCodec::Vp9, Encoder::Videotoolbox)),
            Err("encoder-codec")
        );
        let mut copy = enc(Container::Mkv, VideoCodec::Copy, Encoder::Software);
        assert_eq!(check(&copy), Ok(()));
        copy.max_height = Some(720);
        assert_eq!(check(&copy), Err("copy-resize"));
    }

    #[test]
    fn the_arguments_say_exactly_the_encode() {
        let p = PRESETS[0].encode;
        let a = build_encode_args("/in/a.ts", "/out/a.mp4", &p, true).expect("valid");
        let joined = a.join(" ");
        assert!(
            joined.starts_with("-hide_banner -y -nostats -progress pipe:1 -i /in/a.ts"),
            "{joined}"
        );
        assert!(joined.contains("-vf scale=-2:min(ih\\,1080)"), "{joined}");
        assert!(
            joined.contains("-c:v libx264 -crf 20 -preset medium"),
            "{joined}"
        );
        assert!(joined.contains("-pix_fmt yuv420p"));
        assert!(joined.contains("-c:a aac -b:a 160k -sn -movflags +faststart /out/a.mp4"));
        // one argument per value: a path with spaces stays one argument
        let a = build_encode_args("/in/my clip.ts", "/out/x y.mkv", &PRESETS[4].encode, false)
            .expect("ok");
        assert!(
            a.contains(&"/in/my clip.ts".to_string())
                && a.last().map(String::as_str) == Some("/out/x y.mkv")
        );
        assert!(a.join(" ").contains("-c:v libsvtav1 -crf 30 -preset 8"));
        assert!(a.join(" ").contains("-c:a libopus -b:a 128k"));
    }

    #[test]
    fn hardware_encoders_get_their_own_quality_and_device() {
        let mut e = enc(Container::Mp4, VideoCodec::H265, Encoder::Nvenc);
        let a = build_encode_args("i", "o", &e, false)
            .expect("ok")
            .join(" ");
        assert!(
            a.contains("-c:v hevc_nvenc -rc vbr -cq 23 -b:v 0 -tag:v hvc1"),
            "{a}"
        );
        e.encoder = Encoder::Vaapi;
        e.max_height = Some(720);
        let a = build_encode_args("i", "o", &e, false)
            .expect("ok")
            .join(" ");
        assert!(
            a.starts_with("-hide_banner -y -vaapi_device /dev/dri/renderD128 -i i"),
            "{a}"
        );
        assert!(a.contains(
            "-vf scale=-2:min(ih\\,720),format=nv12,hwupload -c:v hevc_vaapi -rc_mode CQP -qp 23"
        ));
        e.encoder = Encoder::Videotoolbox;
        e.quality = Quality::Bitrate { kbps: 4000 };
        let a = build_encode_args("i", "o", &e, false)
            .expect("ok")
            .join(" ");
        assert!(
            a.contains("-c:v hevc_videotoolbox -b:v 4000k -maxrate 8000k"),
            "{a}"
        );
    }

    #[test]
    fn a_test_encode_exists_for_every_encoder_that_exists() {
        for c in CODECS {
            for e in [Encoder::Software].into_iter().chain(HARDWARE) {
                assert_eq!(
                    test_encode_args(c, e).is_some(),
                    encoder_name(c, e).is_some()
                );
            }
        }
        let t = test_encode_args(VideoCodec::H264, Encoder::Qsv)
            .expect("qsv")
            .join(" ");
        assert!(t.ends_with("-c:v h264_qsv -f null -"), "{t}");
    }

    #[test]
    fn encodes_round_trip_as_the_window_sends_them() {
        let json = serde_json::json!({
            "container": "mkv", "codec": "h265", "encoder": "software",
            "quality": { "kind": "crf", "value": 24 }, "maxHeight": 720,
            "audio": { "codec": "opus", "kbps": 96 }
        });
        let e: Encode = serde_json::from_value(json.clone()).expect("encode");
        assert_eq!(serde_json::to_value(e).expect("json"), json);
        assert!(
            serde_json::from_value::<Encode>(serde_json::json!({ "container": "avi" })).is_err()
        );
    }
}
