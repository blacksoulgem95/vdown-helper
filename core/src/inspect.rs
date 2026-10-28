//! What a download of one playlist will contact and contain (`src/lib/inspect.ts`), used for access checks and the
//! DRM refusal in the background, and by the desktop app before it starts a job.

use serde::Serialize;

use crate::dash::{
    DashContent, DashManifest, DashPeriod, DashRepresentation, DashType, expand_segments,
    protections_of,
};
use crate::hls::{HlsMediaPlaylist, KeyMethod};
use crate::media::extension_of;
use crate::url::parse_url;
use crate::xml::Attrs;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantInspection {
    pub url: String,
    pub segment_count: f64,
    pub duration_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_duration: Option<f64>,
    pub live: bool,
    pub fragmented: bool,
    pub encryption: Vec<String>,
    pub protected_by_drm: bool,
    /// Keys that must be fetched to decrypt (AES-128 only).
    pub key_uris: Vec<String>,
    /// Origins that will be contacted for this job (playlist, segments, keys), used for access checks.
    pub origins: Vec<String>,
    /// One representative URL per origin, used to test whether it can already be reached.
    pub origin_samples: Attrs,
    pub first_segment_ext: String,
}

/// http(s) origin of a URL, like `new URL(u).origin`.
fn http_origin(u: &str) -> Option<String> {
    let url = parse_url(u, None)?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

/// Origins (scheme + host) that a download of this playlist will contact. Used for access checks.
pub fn origins_of<'a>(urls: impl IntoIterator<Item = &'a str>, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for u in urls {
        if let Some(o) = http_origin(u) {
            if !out.contains(&o) {
                out.push(o);
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

pub fn sample_by_origin<'a>(urls: impl IntoIterator<Item = &'a str>, max: usize) -> Attrs {
    let mut out = Attrs::default();
    for u in urls {
        if let Some(o) = http_origin(u) {
            if out.get(&o).is_none() {
                out.set(&o, u.to_string());
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out
}

/// An insertion-ordered set of URLs.
#[derive(Default)]
struct UrlSet(Vec<String>);

impl UrlSet {
    fn add(&mut self, u: &str) {
        if !self.0.iter().any(|x| x == u) {
            self.0.push(u.to_string());
        }
    }
    fn iter(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }
}

pub fn inspect_media_playlist(p: &HlsMediaPlaylist) -> VariantInspection {
    let mut urls = UrlSet::default();
    urls.add(&p.url);
    let mut key_uris = UrlSet::default();
    for s in &p.segments {
        urls.add(&s.uri);
        if let Some(m) = &s.map {
            urls.add(&m.uri);
        }
        if let Some(k) = &s.key {
            if let (Some(uri), KeyMethod::Aes128, false) = (&k.uri, k.method, k.protected_by_drm) {
                key_uris.add(uri);
                urls.add(uri);
            }
        }
    }
    let first = p
        .segments
        .first()
        .map(|s| extension_of(&s.uri))
        .unwrap_or_default();
    VariantInspection {
        url: p.url.clone(),
        segment_count: p.segments.len() as f64,
        duration_sec: p.total_duration,
        target_duration: p.target_duration,
        live: !p.end_list,
        fragmented: p.fragmented,
        encryption: p
            .encryption
            .iter()
            .map(|m| m.as_str().to_string())
            .collect(),
        protected_by_drm: p.has_drm,
        key_uris: key_uris.0,
        origins: origins_of(urls.iter(), 24),
        origin_samples: sample_by_origin(urls.iter(), 24),
        first_segment_ext: if first.is_empty() {
            (if p.fragmented { "m4s" } else { "ts" }).to_string()
        } else {
            first
        },
    }
}

/// Summary of one DASH representation, shaped like the HLS one so the rest of the app treats them alike. `Err` carries
/// the expansion failure (`DashExpandError` in TypeScript).
pub fn inspect_dash_representation(
    m: &DashManifest,
    period: &DashPeriod,
    rep: &DashRepresentation,
    now_ms: f64,
) -> Result<VariantInspection, String> {
    let e = expand_segments(m, period, rep, now_ms)?;
    let mut urls = UrlSet::default();
    urls.add(&m.url);
    for s in &e.segments {
        urls.add(&s.uri);
    }
    if let Some(i) = &e.init {
        urls.add(&i.uri);
    }
    // A subtitle track is separate clear text even when the video of the same stream is encrypted.
    let prot = if rep.content == DashContent::Text {
        protections_of(std::slice::from_ref(rep))
    } else {
        protections_of(&period.representations)
    };
    let first = e
        .segments
        .first()
        .map(|s| extension_of(&s.uri))
        .unwrap_or_default();
    Ok(VariantInspection {
        url: m.url.clone(),
        segment_count: e.segments.len() as f64,
        duration_sec: e.duration_sec,
        target_duration: None,
        live: m.kind == DashType::Dynamic,
        fragmented: true,
        encryption: prot
            .systems
            .iter()
            .map(|s| s.as_str().to_uppercase())
            .collect(),
        // ClearKey is not DRM but its key cannot be obtained yet, so it is refused the same way.
        protected_by_drm: prot.drm || prot.clear_key,
        key_uris: Vec::new(),
        origins: origins_of(urls.iter(), 24),
        origin_samples: sample_by_origin(urls.iter(), 24),
        first_segment_ext: if first.is_empty() {
            "m4s".to_string()
        } else {
            first
        },
    })
}
