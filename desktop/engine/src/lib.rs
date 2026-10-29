//! vdown-helper's desktop download engine (`vdh-engine`), the part of the app that fetches and writes: HLS (AES-128
//! included) and DASH staged to disk with parallel segments, live recording, plain files, and the native ffmpeg that
//! joins and converts them. Every decision (what a stream is, whether it is protected, how it is saved, the ffmpeg
//! arguments) comes from `vdh-core`, the same code the extension runs. Around it, [`manager`] keeps a persistent queue
//! (SQLite) with pause, resume after a restart, a bandwidth cap, a schedule window and a history. Design:
//! `docs/desktop.md`.

pub mod encoders;
pub mod error;
pub mod ffmpeg;
pub mod job;
pub mod limit;
pub mod live;
pub mod manager;
pub mod net;
pub mod probe;
pub mod reencode;
pub mod schedule;
pub mod segments;
pub mod stage;
pub mod store;

pub use error::{EngineError, ErrorCode, Result};
pub use job::{Event, Finished, JobContext, Progress, run};
pub use net::{Net, OriginCookies, RequestHeaders};
