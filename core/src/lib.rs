//! vdown-helper's pure logic, shared by the Chrome extension (compiled to wasm) and the desktop app.
//!
//! No I/O lives here: parsers, DRM verdicts, the output planner and the security helpers take data and return data, so
//! both sides make the same decisions. TypeScript semantics the extension relied on (`Number()`, `trim()`, WHATWG URLs)
//! are reproduced in [`js`] and [`url`]. Design: `docs/desktop.md`.

pub mod analyze;
pub mod dash;
pub mod hls;
pub mod inspect;
pub mod js;
pub mod link;
pub mod media;
pub mod url;
pub mod xml;
