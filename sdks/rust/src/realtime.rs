use crate::client::Client;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Handle for an active realtime subscription. [`Subscription::cancel`]
/// unsubscribes — the same contract as the TS SDK's returned unsubscribe function.
pub struct Subscription {
    stop: Arc<AtomicBool>,
}

impl Subscription {
    pub fn cancel(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Client {
    /// Subscribe to a realtime channel (e.g. "items:posts"). Returns a
    /// [`Subscription`]; `cancel()` unsubscribes. The reader runs on a thread and
    /// auto-reconnects on a dropped stream (3s back-off), replaying via
    /// Last-Event-ID. Uses `ureq` directly (native only).
    pub fn subscribe<F>(&self, channel: &str, on_event: F) -> Subscription
    where
        F: Fn(Value) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let url = format!("{}/api/realtime/{}/subscribe", self.url(), channel);
        let auth = self.auth_header();
        let tenant = self.tenant().map(|s| s.to_string());

        std::thread::spawn(move || {
            let mut last_id: Option<String> = None;
            while !flag.load(Ordering::SeqCst) {
                let mut req = ureq::get(&url).set("Accept", "text/event-stream");
                if let Some(a) = &auth {
                    req = req.set("Authorization", a);
                }
                if let Some(t) = &tenant {
                    req = req.set("X-Backlex-Tenant", t);
                }
                if let Some(id) = &last_id {
                    req = req.set("Last-Event-ID", id);
                }
                if let Ok(resp) = req.call() {
                    let reader = BufReader::new(resp.into_reader());
                    let mut data: Vec<String> = Vec::new();
                    for line in reader.lines() {
                        if flag.load(Ordering::SeqCst) {
                            return;
                        }
                        let line = match line {
                            Ok(l) => l,
                            Err(_) => break,
                        };
                        if line.is_empty() {
                            if !data.is_empty() {
                                let payload = data.join("\n");
                                data.clear();
                                if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                                    on_event(v);
                                }
                            }
                        } else if line.starts_with(':') {
                            // comment / heartbeat
                        } else if let Some(rest) = line.strip_prefix("id:") {
                            last_id = Some(rest.trim().to_string());
                        } else if let Some(rest) = line.strip_prefix("data:") {
                            data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                        }
                    }
                }
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        });

        Subscription { stop }
    }
}
