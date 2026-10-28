//! vdown-helper's pure logic, shared by the Chrome extension (compiled to wasm) and the desktop app.
//!
//! No I/O lives here: parsers, DRM verdicts, the output planner and the security helpers take data and return data, so
//! both sides make the same decisions. The modules arrive in VDH-062 to VDH-064; see `docs/desktop.md`.

pub mod link;
