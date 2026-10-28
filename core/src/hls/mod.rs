//! HLS playlists (`src/lib/hls`): attribute lists and the master/media playlist parser.

pub mod attributes;
pub mod parser;
pub mod types;

pub use parser::{classify_playlist, parse_hls};
pub use types::*;
