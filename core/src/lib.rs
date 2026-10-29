//! vdown-helper's pure logic, shared by the Chrome extension (compiled to wasm) and the desktop app.
//!
//! No I/O lives here: parsers, DRM verdicts, the output planner and the security helpers take data and return data, so
//! both sides make the same decisions. TypeScript semantics the extension relied on (`Number()`, `trim()`, WHATWG URLs)
//! are reproduced in [`js`] and [`url`]. Design: `docs/desktop.md`.

pub mod analyze;
pub mod compat;
pub mod dash;
pub mod data_url;
pub mod ffmpeg_args;
pub mod filetypes;
pub mod hls;
pub mod hook_data;
pub mod inspect;
pub mod js;
pub mod link;
pub mod media;
pub mod metadata;
pub mod mse;
pub mod obj;
pub mod queue;
pub mod replay;
pub mod request;
pub mod resources;
pub mod security;
pub mod settings;
pub mod sniff;
pub mod subtitles;
pub mod tabs;
pub mod url;
pub mod xml;
pub mod zip;
