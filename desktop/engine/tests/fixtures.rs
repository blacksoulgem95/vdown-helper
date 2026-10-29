//! The `vdh` binary against the extension's E2E fixture servers: every output is checked with ffprobe and a full
//! decode, protected streams must be refused. See `common` for what the tests need.

mod common;

use std::path::Path;

use common::*;

#[test]
fn hls_master_gives_the_best_quality_as_mp4() {
    let Some(f) = fixtures() else { return };
    let file = get(f, "hls/master.m3u8", "master", &[]);
    assert_eq!(file.extension().and_then(|e| e.to_str()), Some("mp4"));
    assert!(
        file.to_string_lossy().contains("360p"),
        "{}",
        file.display()
    );
    video_and_audio(&file, 6.0);
}

#[test]
fn a_lower_quality_can_be_chosen() {
    let Some(f) = fixtures() else { return };
    let file = get(
        f,
        "hls/master.m3u8",
        "variant",
        &["--variant", "1", "--name", "small"],
    );
    assert!(file.ends_with("small.mp4"), "{}", file.display());
    video_and_audio(&file, 6.0);
}

#[test]
fn aes_128_streams_are_decrypted() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "hls-aes/index.m3u8", "aes-ts", &[]), 6.0);
    video_and_audio(&get(f, "hls-aes-fmp4/index.m3u8", "aes-fmp4", &[]), 6.0);
}

#[test]
fn separate_audio_is_merged() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "hls-sep/master.m3u8", "sep", &[]), 6.0);
}

#[test]
fn dash_video_and_audio_are_merged() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "dash-vod/manifest.mpd", "dash", &[]), 6.0);
}

#[test]
fn a_plain_file_arrives_byte_for_byte() {
    let Some(f) = fixtures() else { return };
    let file = get(f, "media/sample.mp4", "file", &[]);
    let want = std::fs::read(f.root.join("media/sample.mp4")).expect("fixture");
    assert_eq!(std::fs::read(&file).expect("output"), want);
}

#[test]
fn audio_is_extracted_and_converted() {
    let Some(f) = fixtures() else { return };
    let file = get(
        f,
        "hls-sep/master.m3u8",
        "mp3",
        &["--mode", "audio-only", "--audio-format", "mp3"],
    );
    let p = probe(&file);
    assert_eq!(p.codecs, ["mp3"], "{}", file.display());
    assert!((p.duration - 6.0).abs() < 0.6, "duration {}", p.duration);
    decodes_cleanly(&file);
}

#[test]
fn protected_streams_are_refused() {
    let Some(f) = fixtures() else { return };
    for path in ["hls-drm/index.m3u8", "dash-drm/manifest.mpd"] {
        let dir = out_dir("drm");
        let r = vdh(&[
            "get",
            &format!("{}/{path}", f.a),
            "-o",
            dir.to_str().expect("utf-8"),
        ]);
        assert_eq!(
            (r.code, r.json["code"].as_str()),
            (2, Some("protected")),
            "{path}: {}",
            r.json
        );
        assert_eq!(
            std::fs::read_dir(&dir).map(Iterator::count).unwrap_or(0),
            0,
            "{path}: something was written"
        );
    }
}

#[test]
fn a_hand_over_request_is_rechecked() {
    let Some(f) = fixtures() else { return };
    // a request claiming an unprotected file, pointing at a DRM playlist: the engine reads the playlist itself
    let r = vdh(&["probe", &format!("{}/hls/master.m3u8", f.a)]);
    let mut req = r.json["request"].clone();
    req["sourceUrl"] = format!("{}/hls-drm/index.m3u8", f.a).into();
    let dir = out_dir("forged");
    let file = dir.join("request.json");
    std::fs::write(&file, req.to_string()).expect("write request");
    let r = vdh(&[
        "run",
        file.to_str().expect("utf-8"),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.json["code"].as_str(), Some("protected"), "{}", r.json);
    // the same request unchanged works
    req["sourceUrl"] = format!("{}/hls/v360/index.m3u8", f.a).into();
    std::fs::write(&file, req.to_string()).expect("write request");
    let r = vdh(&[
        "run",
        file.to_str().expect("utf-8"),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.code, 0, "{}", r.json);
    video_and_audio(Path::new(r.json["path"].as_str().expect("path")), 6.0);
}

#[test]
fn the_referer_handed_over_is_sent() {
    let Some(f) = fixtures() else { return };
    let path = format!("__ref/media/sample.mp4?need={}", f.a);
    let dir = out_dir("ref");
    let r = vdh(&[
        "get",
        &format!("{}/{path}", f.a),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.json["code"].as_str(), Some("http-error"), "{}", r.json);
    let referer = format!("{}/pages/main.html", f.a);
    let file = get(f, &path, "ref-ok", &["--referer", &referer]);
    decodes_cleanly(&file);
}

#[test]
fn a_live_stream_is_recorded_until_it_ends() {
    let Some(f) = fixtures() else { return };
    let id = format!("it{}", std::process::id());
    let file = get(
        f,
        &format!("__live/hls/index.m3u8?id={id}&len=5"),
        "live",
        &[],
    );
    video_and_audio(&file, 10.0);
    let file = get(
        f,
        &format!("__live/hlssep/master.m3u8?id={id}s&len=5"),
        "live-sep",
        &[],
    );
    video_and_audio(&file, 10.0);
}

#[cfg(unix)]
#[test]
fn stopping_a_recording_keeps_what_was_recorded() {
    use serde_json::Value;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let Some(f) = fixtures() else { return };
    let dir = out_dir("live-stop");
    let url = format!(
        "{}/__live/hls/index.m3u8?id=stop{}&len=60",
        f.a,
        std::process::id()
    );
    let child = Command::new(env!("CARGO_BIN_EXE_vdh"))
        .args(["get", &url, "-o", dir.to_str().expect("utf-8")])
        .stdout(Stdio::piped())
        .spawn()
        .expect("vdh runs");
    std::thread::sleep(Duration::from_secs(5));
    let started = Instant::now();
    Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .expect("kill");
    let out = child.wait_with_output().expect("vdh ends");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "stopping took too long"
    );
    let json: Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(json["ok"], true, "{json}");
    let file = PathBuf::from(json["path"].as_str().expect("path"));
    let p = probe(&file);
    assert!(p.duration >= 2.0, "duration {}", p.duration);
    decodes_cleanly(&file);
}
