//! FFmpeg argument vectors (`src/lib/ffmpegArgs.ts`). The planner decides copy vs transcode; this only expresses it.
//! Never a shell: the result is an argument vector.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegArgsInput {
    pub mode: String,
    /// Output extension, e.g. mp4, mkv, ts, mp3, m4a, aac, wav.
    pub extension: String,
    pub video: String,
    pub audio: String,
    /// Path of the main input (video stream, or the only input).
    pub video_path: String,
    /// Path of a separate audio input to merge, if any.
    #[serde(default)]
    pub audio_path: Option<String>,
    pub audio_format: String,
    pub audio_bitrate: f64,
    /// Keep the inputs' own timestamps, shifted together so the earliest starts at zero (two live tracks joined).
    #[serde(default)]
    pub keep_offsets: Option<bool>,
    /// Report progress as `key=value` lines on stdout (the desktop app reads them; the extension's FFmpeg.wasm does not).
    #[serde(default)]
    pub progress: Option<bool>,
    pub output: String,
}

fn audio_codec_args(i: &FfmpegArgsInput) -> Vec<String> {
    let br = format!("{}k", crate::js::number_to_string(i.audio_bitrate));
    if i.audio == "copy" {
        return vec!["-c:a".into(), "copy".into()];
    }
    match i.extension.as_str() {
        "mp3" => vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), br],
        "wav" => vec!["-c:a".into(), "pcm_s16le".into()],
        // m4a / aac, and re-encoding audio to fit a video container
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), br],
    }
}

pub fn build_ffmpeg_args(i: &FfmpegArgsInput) -> Vec<String> {
    let s = |x: &str| x.to_string();
    // +genpts: legacy containers often carry no timestamps for copied packets, which Matroska/MP4 muxers refuse.
    let mut args = vec![s("-hide_banner"), s("-y")];
    if i.progress == Some(true) {
        args.extend([s("-nostats"), s("-progress"), s("pipe:1")]);
    }
    args.extend([s("-fflags"), s("+genpts")]);
    let keep = i.keep_offsets == Some(true);
    if keep {
        args.push(s("-copyts"));
    }
    if i.mode == "audio-only" {
        args.extend([
            s("-i"),
            i.audio_path.clone().unwrap_or_else(|| i.video_path.clone()),
        ]);
        args.extend([s("-vn"), s("-map"), s("0:a:0")]);
        args.extend(audio_codec_args(i));
        args.push(i.output.clone());
        return args;
    }
    args.extend([s("-i"), i.video_path.clone()]);
    if let Some(a) = &i.audio_path {
        args.extend([s("-i"), a.clone()]);
    }
    args.extend([s("-map"), s("0:v:0")]);
    if i.audio == "none" {
        args.extend([s("-c:v"), s("copy"), s("-an")]);
    } else {
        let map = if i.audio_path.is_some() {
            "1:a:0"
        } else {
            "0:a:0?"
        };
        args.extend([s("-map"), s(map), s("-c:v"), s("copy")]);
        args.extend(audio_codec_args(i));
    }
    if i.extension == "mp4" || i.extension == "m4a" {
        args.extend([s("-movflags"), s("+faststart")]);
    }
    if keep {
        args.extend([s("-avoid_negative_ts"), s("make_zero")]);
    }
    args.push(i.output.clone());
    args
}

/// MIME type for an output extension.
pub fn mime_by_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "ts" => "video/mp2t",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "mka" => "audio/x-matroska",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "ttml" => "application/ttml+xml",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_is_reported_only_when_asked() {
        let mut i = FfmpegArgsInput {
            mode: "video-audio".into(),
            extension: "mp4".into(),
            video: "copy".into(),
            audio: "copy".into(),
            video_path: "/in/v.ts".into(),
            audio_path: None,
            audio_format: "mp3".into(),
            audio_bitrate: 192.0,
            keep_offsets: None,
            progress: None,
            output: "/out/o.mp4".into(),
        };
        assert!(!build_ffmpeg_args(&i).contains(&"-progress".to_string()));
        i.progress = Some(true);
        let args = build_ffmpeg_args(&i);
        assert_eq!(
            &args[..5],
            ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"]
        );
        assert_eq!(args.last().map(String::as_str), Some("/out/o.mp4"));
    }
}
