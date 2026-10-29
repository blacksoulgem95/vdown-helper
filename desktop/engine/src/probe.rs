//! What an address is, for jobs that did not come from the browser: a master or media playlist, a DASH manifest or a
//! plain file. The result is the same resource the extension's scan would describe, so `vdh-core` builds the request
//! exactly as the extension does. Protected streams are refused here already.

use serde::Serialize;
use vdh_core::analyze::{dash_resource, media_playlist_verdict};
use vdh_core::hls::{HlsParseResult, HlsPlaylist, RenditionType, classify_playlist, parse_hls};
use vdh_core::media::{format_from_mime, format_from_url, infer_title, media_type_of};
use vdh_core::request::{
    Choices, DownloadRequest, InspectionFacts, MediaResource, PlaylistFacts, build_live_request,
    build_request, default_choices,
};
use vdh_core::resources::resource_id;
use vdh_core::settings::Settings;
use vdh_core::sniff::sniff_mime;

use crate::error::{EngineError, Result};
use crate::net::{MAX_TEXT_BYTES, Net};

/// What the user may choose for a standalone job; unset fields follow the settings.
#[derive(Debug, Clone, Default)]
pub struct Wanted {
    pub mode: Option<String>,
    pub container: Option<String>,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<f64>,
    /// Index into the master playlist's variants.
    pub variant: Option<i64>,
    /// A file name to use instead of the naming template.
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probed {
    pub kind: String,
    pub format: String,
    pub title: String,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    /// `[height, bandwidth]` of each variant, in the playlist's order.
    pub variants: Vec<(Option<f64>, f64)>,
    pub request: DownloadRequest,
}

/// Today's date (UTC) as YYYY-MM-DD, for names built from the template.
pub fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400) as i64;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn base_resource(url: &str, kind: &str, format: &str, media_type: &str) -> MediaResource {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    MediaResource {
        id: resource_id(url),
        url: url.into(),
        tab_id: -1.0,
        page_url: String::new(),
        page_title: String::new(),
        host,
        title: infer_title(url, None, None),
        kind: kind.into(),
        format: format.into(),
        media_type: media_type.into(),
        mime_type: None,
        size_bytes: None,
        duration_sec: None,
        height: None,
        bitrate: None,
        codecs: None,
        variants: Vec::new(),
        audio_tracks: Vec::new(),
        language: None,
        ext: None,
        playlist: None,
        held: None,
    }
}

/// The playlist of one variant: refused when protected, described otherwise.
async fn inspect_variant(net: &Net, url: &str) -> Result<InspectionFacts> {
    let (text, final_url) = net.text(url).await?;
    let HlsParseResult::Ok {
        playlist: HlsPlaylist::Media(p),
        ..
    } = parse_hls(&text, &final_url)
    else {
        return Err(EngineError::invalid("The variant is not a media playlist"));
    };
    let verdict = media_playlist_verdict(&p);
    if verdict.status == "protected" {
        return Err(EngineError::protected(
            "This stream is protected and cannot be downloaded",
        ));
    }
    Ok(InspectionFacts {
        duration_sec: (p.total_duration > 0.0).then_some(p.total_duration),
        fragmented: Some(p.fragmented),
        live: Some(!p.end_list),
    })
}

/// Read an address far enough to know what it is, and describe it as a resource.
async fn resource_of(net: &Net, url: &str) -> Result<(MediaResource, Option<InspectionFacts>)> {
    let mut res = net.get(url, None).await?;
    let final_url = res.url().to_string();
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|m| m.split(';').next().unwrap_or("").trim().to_lowercase());
    let size = res.content_length();
    let mut head = Vec::new();
    while head.len() < 4096 {
        match res.chunk().await {
            Ok(Some(c)) => head.extend_from_slice(&c),
            _ => break,
        }
    }
    let start = String::from_utf8_lossy(&head[..head.len().min(1024)])
        .trim_start()
        .to_string();
    let textual =
        start.starts_with("#EXTM3U") || start.starts_with("<?xml") || start.starts_with("<MPD");
    if !textual {
        drop(res);
        let format = format_from_mime(mime.as_deref())
            .or_else(|| format_from_url(&final_url))
            .or_else(|| sniff_mime(&head).and_then(|m| format_from_mime(Some(m))))
            .unwrap_or("unknown");
        let mut r = base_resource(url, "file", format, media_type_of(format));
        r.mime_type = mime;
        r.size_bytes = size.map(|s| s as f64);
        return Ok((r, None));
    }
    // a playlist or a manifest: read the rest of it
    while let Some(c) = res
        .chunk()
        .await
        .map_err(|_| EngineError::invalid("The playlist could not be read"))?
    {
        head.extend_from_slice(&c);
        if head.len() > MAX_TEXT_BYTES {
            return Err(EngineError::invalid("The playlist is too large"));
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    if matches!(classify_playlist(&text), vdh_core::hls::PlaylistClass::Dash)
        || start.starts_with("<MPD")
        || text.contains("<MPD")
    {
        let patch = dash_resource(&text, &final_url);
        if patch
            .downloadability
            .as_ref()
            .is_some_and(|d| d.status == "protected")
        {
            return Err(EngineError::protected(
                "This stream is protected and cannot be downloaded",
            ));
        }
        if patch.kind.is_some_and(|k| k != "dash") {
            return Err(EngineError::invalid(
                "This manifest has nothing that can be downloaded",
            ));
        }
        let media_type = patch.media_type.unwrap_or("video");
        let mut r = base_resource(url, patch.kind.unwrap_or("dash"), "dash", media_type);
        r.variants = patch.variants.unwrap_or_default();
        r.audio_tracks = patch.audio_tracks.unwrap_or_default();
        r.duration_sec = patch.duration_sec;
        r.codecs = patch.codecs;
        r.height = patch.height;
        r.playlist = patch.playlist.map(|p| PlaylistFacts {
            fragmented: p.fragmented,
            live: p.live,
        });
        return Ok((r, None));
    }
    match parse_hls(&text, &final_url) {
        HlsParseResult::Ok {
            playlist: HlsPlaylist::Master(m),
            ..
        } => {
            if m.session_keys.iter().any(|k| k.protected_by_drm) {
                return Err(EngineError::protected(
                    "This stream is protected and cannot be downloaded",
                ));
            }
            let audio_only = m.variants.is_empty();
            let mut r = base_resource(
                url,
                "hls-master",
                "hls",
                if audio_only { "audio" } else { "video" },
            );
            r.variants = m.variants;
            r.audio_tracks = m
                .renditions
                .into_iter()
                .filter(|x| x.kind == RenditionType::Audio)
                .collect();
            Ok((r, None))
        }
        HlsParseResult::Ok {
            playlist: HlsPlaylist::Media(p),
            ..
        } => {
            if media_playlist_verdict(&p).status == "protected" {
                return Err(EngineError::protected(
                    "This stream is protected and cannot be downloaded",
                ));
            }
            let mut r = base_resource(url, "hls-media", "hls", "video");
            r.duration_sec = (p.total_duration > 0.0).then_some(p.total_duration);
            r.playlist = Some(PlaylistFacts {
                fragmented: Some(p.fragmented),
                live: Some(!p.end_list),
            });
            Ok((r, None))
        }
        HlsParseResult::Err { error, .. } => Err(EngineError::invalid(format!(
            "Playlist error: {:?}",
            error.code
        ))),
    }
}

/// Describe `url` and build the request the user's choices make of it.
pub async fn probe(net: &Net, url: &str, settings: &Settings, wanted: &Wanted) -> Result<Probed> {
    let (resource, _) = resource_of(net, url).await?;
    let mut choices: Choices = default_choices(&resource, settings);
    if let Some(m) = &wanted.mode {
        choices.mode.clone_from(m);
    }
    if let Some(c) = &wanted.container {
        choices.container.clone_from(c);
    }
    if let Some(f) = &wanted.audio_format {
        choices.audio_format.clone_from(f);
    }
    if let Some(b) = wanted.audio_bitrate {
        choices.audio_bitrate = b;
    }
    if let Some(v) = wanted.variant {
        if v < 0 || v as usize >= resource.variants.len() {
            return Err(EngineError::invalid("There is no such quality"));
        }
        choices.variant_index = v;
    }
    // The playlist of the chosen variant says whether it is live and whether it is protected.
    let inspection = if resource.kind == "hls-master" {
        match usize::try_from(choices.variant_index)
            .ok()
            .and_then(|i| resource.variants.get(i))
        {
            Some(v) => Some(inspect_variant(net, &v.uri).await?),
            None => None,
        }
    } else {
        None
    };
    let live = inspection
        .as_ref()
        .and_then(|i| i.live)
        .or(resource.playlist.as_ref().and_then(|p| p.live))
        .unwrap_or(false);
    let today = today();
    let mut request = if live {
        build_live_request(&resource, settings, &today)
    } else {
        build_request(&resource, settings, &choices, inspection.as_ref(), &today)
    };
    if let Some(f) = &wanted.filename {
        request.filename.clone_from(f);
    }
    Ok(Probed {
        kind: resource.kind.clone(),
        format: resource.format.clone(),
        title: resource.title.clone(),
        live,
        duration_sec: inspection
            .as_ref()
            .and_then(|i| i.duration_sec)
            .or(resource.duration_sec),
        variants: resource
            .variants
            .iter()
            .map(|v| (v.height, v.bandwidth))
            .collect(),
        request,
    })
}
