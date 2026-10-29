//! A global bandwidth cap shared by every job: a token bucket refilled at the chosen rate, one second of burst. Readers
//! take what they read and wait for the debt to be paid, so the average over a few seconds stays at the cap.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct Bucket {
    /// Bytes per second; 0 = no cap.
    rate: f64,
    tokens: f64,
    last: Instant,
}

#[derive(Debug)]
pub struct RateLimit {
    bucket: Mutex<Bucket>,
}

impl RateLimit {
    /// A cap of `bytes_per_second` (0 = none).
    pub fn new(bytes_per_second: u64) -> Self {
        Self {
            bucket: Mutex::new(Bucket {
                rate: bytes_per_second as f64,
                tokens: bytes_per_second as f64,
                last: Instant::now(),
            }),
        }
    }

    /// Change the cap while jobs run.
    pub fn set_rate(&self, bytes_per_second: u64) {
        if let Ok(mut b) = self.bucket.lock() {
            b.rate = bytes_per_second as f64;
            b.tokens = b.tokens.min(b.rate);
        }
    }

    /// How long a reader of `n` bytes has to wait now.
    fn debit(&self, n: usize) -> Duration {
        let Ok(mut b) = self.bucket.lock() else {
            return Duration::ZERO;
        };
        if b.rate <= 0.0 {
            return Duration::ZERO;
        }
        let now = Instant::now();
        let refill = now.duration_since(b.last).as_secs_f64() * b.rate;
        b.tokens = (b.tokens + refill).min(b.rate);
        b.last = now;
        b.tokens -= n as f64;
        if b.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-b.tokens / b.rate)
        }
    }

    /// Account for `n` bytes read, waiting as long as the cap requires.
    pub async fn take(&self, n: usize) {
        let wait = self.debit(n);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_cap_never_waits() {
        let l = RateLimit::new(0);
        assert!(l.debit(10_000_000).is_zero());
    }

    #[test]
    fn a_cap_spreads_reads_over_time() {
        let l = RateLimit::new(1000);
        // one second of burst, then one second of debt per 1000 bytes
        assert!(l.debit(1000).is_zero());
        let w = l.debit(2000);
        assert!(
            w >= Duration::from_millis(1900) && w <= Duration::from_millis(2100),
            "{w:?}"
        );
    }
}
