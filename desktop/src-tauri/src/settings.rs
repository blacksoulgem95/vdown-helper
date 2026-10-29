//! The app's settings, kept in the queue database (so the `vdh` command line and the app share one place).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use vdh_engine::manager::ManagerOptions;
use vdh_engine::schedule::Window;
use vdh_engine::store::Store;
use vdh_engine::{EngineError, Result};

const KEY: &str = "app";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Where finished files go; empty means `Downloads/vdown-helper`.
    pub out_dir: String,
    /// Jobs at a time.
    pub max_jobs: u32,
    /// Segments at a time, per job.
    pub segments: u32,
    /// Bandwidth cap for all jobs together, in KiB/s (0 = none).
    pub rate_kbps: u64,
    /// When jobs may run, such as `Mon-Fri 22:00-06:00`; empty means always.
    pub window: String,
    /// Keep finished jobs in the history.
    pub history: bool,
    /// Closing the window keeps the app (and its jobs) running in the tray.
    pub close_to_tray: bool,
    /// Start (in the tray) when the user logs in. Off until the user turns it on.
    pub start_at_login: bool,
    /// A system notification when a job ends.
    pub notifications: bool,
    /// `auto` (the system's language), `en` or `it`.
    pub language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            out_dir: String::new(),
            max_jobs: 3,
            segments: 4,
            rate_kbps: 0,
            window: String::new(),
            history: true,
            close_to_tray: true,
            start_at_login: false,
            notifications: true,
            language: "auto".into(),
        }
    }
}

impl AppSettings {
    /// The settings as given, with numbers brought into range; an unreadable schedule window is refused.
    pub fn sanitized(mut self) -> Result<Self> {
        self.max_jobs = self.max_jobs.clamp(1, 8);
        self.segments = self.segments.clamp(1, 16);
        self.rate_kbps = self.rate_kbps.min(10_000_000);
        self.window = self.window.trim().to_string();
        self.out_dir = self.out_dir.trim().to_string();
        if !self.out_dir.is_empty() && !Path::new(&self.out_dir).is_absolute() {
            return Err(EngineError::invalid(
                "The download folder must be a full path",
            ));
        }
        self.schedule()?;
        if !matches!(self.language.as_str(), "auto" | "en" | "it") {
            self.language = "auto".into();
        }
        Ok(self)
    }

    fn schedule(&self) -> Result<Option<Window>> {
        if self.window.is_empty() {
            Ok(None)
        } else {
            Window::parse(&self.window)
                .map(Some)
                .map_err(|e| EngineError::invalid(format!("Not a valid schedule: {}", e.message)))
        }
    }

    pub fn load(store: &Store) -> Self {
        store
            .setting(KEY)
            .and_then(|s| serde_json::from_str::<Self>(&s).ok())
            .and_then(|s| s.sanitized().ok())
            .unwrap_or_default()
    }

    pub fn save(&self, store: &Store) -> Result<()> {
        let json = serde_json::to_string(self).map_err(|e| EngineError::invalid(e.to_string()))?;
        store.set_setting(KEY, &json)?;
        // the queue reads this one itself
        store.set_setting("history", if self.history { "on" } else { "off" })
    }

    pub fn out_dir(&self, default: &Path) -> PathBuf {
        if self.out_dir.is_empty() {
            default.to_path_buf()
        } else {
            PathBuf::from(&self.out_dir)
        }
    }

    pub fn options(&self, default_out: &Path, staging: PathBuf) -> ManagerOptions {
        ManagerOptions {
            max_jobs: self.max_jobs as usize,
            segment_concurrency: self.segments as usize,
            rate_bps: self.rate_kbps * 1024,
            window: self.schedule().ok().flatten(),
            ..ManagerOptions::new(self.out_dir(default_out), staging)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_brought_into_range() {
        let s = AppSettings {
            max_jobs: 0,
            segments: 99,
            language: "fr".into(),
            ..AppSettings::default()
        }
        .sanitized()
        .expect("valid");
        assert_eq!((s.max_jobs, s.segments), (1, 16));
        assert_eq!(s.language, "auto");
    }

    #[test]
    fn a_bad_window_or_a_relative_folder_is_refused() {
        let bad = AppSettings {
            window: "sometimes".into(),
            ..AppSettings::default()
        };
        assert!(bad.sanitized().is_err());
        let relative = AppSettings {
            out_dir: "downloads".into(),
            ..AppSettings::default()
        };
        assert!(relative.sanitized().is_err());
    }

    #[test]
    fn saved_settings_come_back_and_drive_the_history_switch() {
        let store = Store::in_memory().expect("store");
        assert_eq!(AppSettings::load(&store), AppSettings::default());
        let s = AppSettings {
            history: false,
            window: "Mon-Fri 22:00-06:00".into(),
            ..AppSettings::default()
        };
        s.save(&store).expect("saved");
        assert_eq!(AppSettings::load(&store), s);
        assert_eq!(store.setting("history").as_deref(), Some("off"));
        let opts = s.options(Path::new("/d"), PathBuf::from("/s"));
        assert!(opts.window.is_some());
        assert_eq!(opts.out_dir, PathBuf::from("/d"));
    }
}
