//! Types produced by the HLS parser; serialised exactly like `src/types/hls.ts` (camelCase, absent optional fields).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaylistClass {
    HlsMaster,
    HlsMedia,
    M3uPlain,
    Dash,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KeyMethod {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "AES-128")]
    Aes128,
    #[serde(rename = "SAMPLE-AES")]
    SampleAes,
    #[serde(rename = "SAMPLE-AES-CTR")]
    SampleAesCtr,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

impl KeyMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::Aes128 => "AES-128",
            Self::SampleAes => "SAMPLE-AES",
            Self::SampleAesCtr => "SAMPLE-AES-CTR",
            Self::Unknown => "UNKNOWN",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsKey {
    pub method: KeyMethod,
    /// Absolute URL of the key, when the method needs one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    /// Hex IV including 0x prefix, exactly as written in the playlist.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub iv: Option<String>,
    pub key_format: String,
    /// True when the key uses a DRM key system or a method this project will not decrypt.
    pub protected_by_drm: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HlsByteRange {
    pub length: f64,
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMap {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub byte_range: Option<HlsByteRange>,
    /// Key in effect where the EXT-X-MAP tag appears; it also encrypts the init section.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub key: Option<HlsKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsSegment {
    pub uri: String,
    pub duration: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    /// Media sequence number of this segment.
    pub sequence: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub byte_range: Option<HlsByteRange>,
    pub discontinuity: bool,
    /// Effective key at this segment (absent when unencrypted).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub key: Option<HlsKey>,
    /// Effective initialisation section (fMP4/CMAF).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub map: Option<HlsMap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlaylistType {
    #[serde(rename = "VOD")]
    Vod,
    #[serde(rename = "EVENT")]
    Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMediaPlaylist {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_duration: Option<f64>,
    pub media_sequence: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub playlist_type: Option<PlaylistType>,
    /// False for live playlists that never receive #EXT-X-ENDLIST.
    pub end_list: bool,
    pub segments: Vec<HlsSegment>,
    pub total_duration: f64,
    /// Unique key methods present, in order of appearance. Empty when unencrypted.
    pub encryption: Vec<KeyMethod>,
    pub has_drm: bool,
    /// True if any segment uses an fMP4 init section.
    pub fragmented: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsVariant {
    pub uri: String,
    pub bandwidth: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub average_bandwidth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub codecs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub video_range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub audio_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle_group: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RenditionType {
    #[serde(rename = "AUDIO")]
    Audio,
    #[serde(rename = "VIDEO")]
    Video,
    #[serde(rename = "SUBTITLES")]
    Subtitles,
    #[serde(rename = "CLOSED-CAPTIONS")]
    ClosedCaptions,
}

impl RenditionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Audio => "AUDIO",
            Self::Video => "VIDEO",
            Self::Subtitles => "SUBTITLES",
            Self::ClosedCaptions => "CLOSED-CAPTIONS",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsRendition {
    #[serde(rename = "type")]
    pub kind: RenditionType,
    pub group_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub language: Option<String>,
    /// Absent when the rendition is muxed into the variant streams.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    pub is_default: bool,
    pub auto_select: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub channels: Option<String>,
    /// Codec string when the manifest states it per track (DASH does; HLS lists audio codecs on the variants).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub codecs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HlsMasterPlaylist {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<f64>,
    pub variants: Vec<HlsVariant>,
    pub renditions: Vec<HlsRendition>,
    /// Count of #EXT-X-I-FRAME-STREAM-INF entries (trick-play only, never offered for download).
    pub i_frame_streams: f64,
    /// Keys declared via #EXT-X-SESSION-KEY.
    pub session_keys: Vec<HlsKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum HlsPlaylist {
    #[serde(rename = "hls-master")]
    Master(HlsMasterPlaylist),
    #[serde(rename = "hls-media")]
    Media(HlsMediaPlaylist),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsErrorCode {
    Empty,
    NotM3u,
    NotHls,
    Dash,
    Malformed,
    UnsafeUrl,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HlsError {
    pub code: HlsErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<f64>,
}

/// `{ ok: true, playlist } | { ok: false, error }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HlsParseResult {
    Ok { ok: OkTrue, playlist: HlsPlaylist },
    Err { ok: OkFalse, error: HlsError },
}

/// The literal `true` of a result's `ok` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkTrue;
/// The literal `false` of a result's `ok` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OkFalse;

macro_rules! bool_literal {
    ($t:ty, $v:expr) => {
        impl Serialize for $t {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_bool($v)
            }
        }
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                if bool::deserialize(d)? == $v {
                    Ok(Self)
                } else {
                    Err(serde::de::Error::custom(concat!(
                        "expected ",
                        stringify!($v)
                    )))
                }
            }
        }
    };
}
bool_literal!(OkTrue, true);
bool_literal!(OkFalse, false);

impl HlsParseResult {
    pub fn ok(playlist: HlsPlaylist) -> Self {
        Self::Ok {
            ok: OkTrue,
            playlist,
        }
    }
    pub fn err(code: HlsErrorCode, message: &str, line: Option<usize>) -> Self {
        Self::Err {
            ok: OkFalse,
            error: HlsError {
                code,
                message: message.to_string(),
                line: line.map(|l| l as f64),
            },
        }
    }
}
