//! The schedule window: the days and hours (local time) jobs may run in, e.g. `Mon-Fri 22:00-06:00` or `daily
//! 01:00-07:00`. A window that crosses midnight belongs to the day it starts on. Outside it, running jobs are paused
//! (they keep what they fetched) and start again when it opens.

use chrono::{Datelike, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};

const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    /// Monday first.
    pub days: [bool; 7],
    /// Minutes after midnight.
    pub start: u32,
    pub end: u32,
}

fn day(s: &str) -> Result<usize> {
    let s = s.trim().to_ascii_lowercase();
    DAYS.iter()
        .position(|d| s.starts_with(d))
        .ok_or_else(|| EngineError::invalid(format!("Not a day: {s}")))
}

fn minutes(s: &str) -> Result<u32> {
    let bad = || EngineError::invalid(format!("Not a time (HH:MM): {s}"));
    let (h, m) = s.trim().split_once(':').ok_or_else(bad)?;
    let (h, m): (u32, u32) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if h > 24 || m > 59 || (h == 24 && m > 0) {
        return Err(bad());
    }
    Ok(h * 60 + m)
}

impl Window {
    /// `[days] HH:MM-HH:MM`; days are `daily` (the default), `Mon-Fri`, `Sat,Sun`, `Mon,Wed-Fri`...
    pub fn parse(spec: &str) -> Result<Self> {
        let spec = spec.trim();
        let (days_spec, hours) = spec.rsplit_once(' ').unwrap_or(("daily", spec));
        let mut days = [false; 7];
        if days_spec.trim().eq_ignore_ascii_case("daily") {
            days = [true; 7];
        } else {
            for part in days_spec.split(',') {
                match part.split_once('-') {
                    Some((a, b)) => {
                        let (a, b) = (day(a)?, day(b)?);
                        let mut d = a;
                        loop {
                            days[d] = true;
                            if d == b {
                                break;
                            }
                            d = (d + 1) % 7;
                        }
                    }
                    None => days[day(part)?] = true,
                }
            }
        }
        let (a, b) = hours
            .split_once('-')
            .ok_or_else(|| EngineError::invalid("The hours look like 22:00-06:00"))?;
        let (start, end) = (minutes(a)?, minutes(b)?);
        if start == end {
            return Err(EngineError::invalid(
                "The window starts and ends at the same time",
            ));
        }
        Ok(Self { days, start, end })
    }

    /// Whether jobs may run at this local time.
    pub fn allows(&self, t: NaiveDateTime) -> bool {
        let now = t.hour() * 60 + t.minute();
        let today = t.weekday().num_days_from_monday() as usize;
        if self.start < self.end {
            self.days[today] && now >= self.start && now < self.end
        } else if now >= self.start {
            self.days[today]
        } else {
            // after midnight: the window began yesterday
            now < self.end && self.days[(today + 6) % 7]
        }
    }

    /// Whether jobs may run now (local time).
    pub fn allows_now(&self) -> bool {
        self.allows(chrono::Local::now().naive_local())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .and_then(|x| x.and_hms_opt(h, min, 0))
            .expect("date")
    }

    #[test]
    fn overnight_weekday_window() {
        // 2026-10-30 is a Friday, 2026-10-31 a Saturday, 2026-11-01 a Sunday
        let w = Window::parse("Mon-Fri 22:00-06:00").expect("parse");
        assert!(w.allows(at(2026, 10, 30, 23, 0)));
        assert!(w.allows(at(2026, 10, 31, 5, 59))); // Saturday morning: Friday's window
        assert!(!w.allows(at(2026, 10, 31, 23, 0))); // Saturday night: no window
        assert!(!w.allows(at(2026, 11, 1, 3, 0))); // Sunday morning: Saturday had none
        assert!(!w.allows(at(2026, 10, 30, 12, 0)));
    }

    #[test]
    fn day_lists_and_errors() {
        let w = Window::parse("Sat,Sun 09:30-12:00").expect("parse");
        assert_eq!(w.days, [false, false, false, false, false, true, true]);
        assert_eq!((w.start, w.end), (570, 720));
        assert_eq!(Window::parse("01:00-07:00").expect("parse").days, [true; 7]);
        assert_eq!(
            Window::parse("Fri-Mon 01:00-02:00").expect("parse").days,
            [true, false, false, false, true, true, true]
        );
        for bad in [
            "Mon-Fri",
            "Mon 25:00-01:00",
            "Funday 01:00-02:00",
            "01:00-01:00",
        ] {
            assert!(Window::parse(bad).is_err(), "{bad}");
        }
    }
}
