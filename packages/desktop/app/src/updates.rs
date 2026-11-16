//! Updates from the release feeds, for a copy installed or packed by Velopack.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

use aiostreams_desktop_core::bridge::{Outbound, UpdateChannel};
use velopack::bundle::Manifest;
use velopack::locator::{LocationContext, auto_locate_app_manifest};
use velopack::sources::UpdateSource;
use velopack::{
    UpdateCheck, UpdateInfo, UpdateManager, UpdateOptions, VelopackAsset, VelopackAssetFeed,
};

// This fork's own feeds, so a copy with the Dolby Vision DM updates to this fork's builds and not
// upstream's, which would replace it with a build without the DM.
const RELEASES: &str = "https://github.com/ThePotato97/AIOStreams/releases/download";
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// Velopack's names for the operating systems, which begin its channel names.
const OS: &str = if cfg!(windows) {
    "win"
} else if cfg!(target_os = "macos") {
    "osx"
} else {
    "linux"
};
const ARCH: &str = if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "x64"
};

/// Each channel's feed lives on one release that every build of it replaces.
fn feed(channel: UpdateChannel) -> String {
    if let Ok(url) = std::env::var("AIOSTREAMS_UPDATE_FEED") {
        return url;
    }
    match channel {
        UpdateChannel::Stable => format!("{RELEASES}/desktop/"),
        UpdateChannel::Nightly => format!("{RELEASES}/desktop-nightly/"),
    }
}

fn velopack_channel(channel: UpdateChannel) -> String {
    match channel {
        UpdateChannel::Stable => format!("{OS}-{ARCH}"),
        UpdateChannel::Nightly => format!("{OS}-{ARCH}-nightly"),
    }
}

pub enum Command {
    /// `None` keeps the channel this copy was installed from.
    Check(Option<UpdateChannel>),
    Apply,
}

pub struct Updater {
    commands: Sender<Command>,
}

impl Updater {
    /// Nothing to update in a build Velopack did not pack, such as `cargo run`.
    pub fn start(emit: impl Fn(Outbound) + Send + 'static) -> Option<Updater> {
        let installed = match auto_locate_app_manifest(LocationContext::FromCurrentExe) {
            Ok(locator) => locator.get_manifest_channel(),
            Err(e) => {
                log::info!("updates off: {e}");
                return None;
            }
        };
        let installed = if installed.ends_with("-nightly") {
            UpdateChannel::Nightly
        } else {
            UpdateChannel::Stable
        };
        let (commands, received) = mpsc::channel();
        std::thread::Builder::new()
            .name("updates".into())
            .spawn(move || {
                let mut state = State {
                    installed,
                    channel: installed,
                    ready: None,
                    emit,
                };
                loop {
                    match received.recv_timeout(RECHECK) {
                        Ok(Command::Check(channel)) => state.check(channel),
                        Ok(Command::Apply) => state.apply(),
                        Err(RecvTimeoutError::Timeout) => state.check(None),
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            })
            .ok()?;
        Some(Updater { commands })
    }

    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

struct State<E> {
    installed: UpdateChannel,
    channel: UpdateChannel,
    /// Downloaded and waiting for a restart.
    ready: Option<(UpdateManager, UpdateInfo)>,
    emit: E,
}

impl<E: Fn(Outbound)> State<E> {
    fn report(&self, state: &'static str, version: Option<String>, error: Option<String>) {
        (self.emit)(Outbound::UpdateState {
            state,
            channel: Some(self.channel),
            version,
            error,
        });
    }

    fn manager(&self) -> Result<UpdateManager, velopack::Error> {
        let options = UpdateOptions {
            ExplicitChannel: Some(velopack_channel(self.channel)),
            // Leaving nightlies for stable goes back a version.
            AllowVersionDowngrade: self.channel != self.installed,
            ..Default::default()
        };
        UpdateManager::new(
            SystemTrustSource::new(feed(self.channel)),
            Some(options),
            None,
        )
    }

    fn check(&mut self, channel: Option<UpdateChannel>) {
        if let Some(channel) = channel.filter(|c| *c != self.channel) {
            self.channel = channel;
            self.ready = None;
        }
        if let Some((_, info)) = &self.ready {
            let version = info.TargetFullRelease.Version.clone();
            return self.report("ready", Some(version), None);
        }
        self.report("checking", None, None);
        let found = self.manager().and_then(|manager| {
            let check = manager.check_for_updates()?;
            Ok((manager, check))
        });
        match found {
            Ok((manager, UpdateCheck::UpdateAvailable(info))) => {
                let version = info.TargetFullRelease.Version.clone();
                log::info!("update found version={version} channel={:?}", self.channel);
                self.report("downloading", Some(version.clone()), None);
                match manager.download_updates(&info, None) {
                    Ok(()) => {
                        log::info!("update downloaded version={version}");
                        self.ready = Some((manager, *info));
                        self.report("ready", Some(version), None);
                    }
                    Err(e) => self.fail(e),
                }
            }
            Ok(_) => self.report("current", None, None),
            Err(e) => self.fail(e),
        }
    }

    fn apply(&self) {
        let Some((manager, info)) = &self.ready else {
            return;
        };
        log::info!("restarting into version={}", info.TargetFullRelease.Version);
        // Exits on success.
        if let Err(e) = manager.apply_updates_and_restart(&info.TargetFullRelease) {
            self.fail(e);
        }
    }

    fn fail(&self, error: velopack::Error) {
        log::warn!("update failed: {error}");
        self.report("error", None, Some(error.to_string()));
    }
}

/// Velopack's HttpSource, with certificates checked by the system rather than against
/// webpki-roots, Mozilla's list, which velopack's own agent uses alone. A PC whose HTTPS
/// goes through a scanner or filter that re-signs it with a root of its own trusts that
/// root, and so does this; velopack's agent fails there with UnknownIssuer.
#[derive(Clone)]
struct SystemTrustSource {
    url: String,
    agent: ureq::Agent,
}

impl SystemTrustSource {
    fn new(url: String) -> Self {
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .user_agent(concat!("AIOStreams Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self { url, agent }
    }

    fn base(&self) -> Result<url::Url, velopack::Error> {
        Ok(url::Url::parse(
            &(self.url.trim_end_matches('/').to_owned() + "/"),
        )?)
    }
}

impl UpdateSource for SystemTrustSource {
    // As HttpSource: releases.<channel>.json, with the same query
    fn get_release_feed(
        &self,
        channel: &str,
        app: &Manifest,
        staged_user_id: &str,
    ) -> Result<VelopackAssetFeed, velopack::Error> {
        let mut url = self.base()?.join(&format!("releases.{channel}.json"))?;
        url.set_query(Some(&format!(
            "localVersion={}&id={}&stagingId={staged_user_id}",
            app.version, app.id
        )));
        log::info!("update feed {url}");
        let json = self
            .agent
            .get(url.as_str())
            .call()?
            .body_mut()
            .read_to_string()?;
        Ok(serde_json::from_str(&json)?)
    }

    // As velopack's download: progress in steps of 5%, when the size is known
    fn download_release_entry(
        &self,
        asset: &VelopackAsset,
        local_file: &std::path::Path,
        progress: Option<Sender<i16>>,
    ) -> Result<(), velopack::Error> {
        use std::io::{Read, Write};
        let url = self.base()?.join(&asset.FileName)?;
        log::info!("update download {url}");
        let (head, body) = self.agent.get(url.as_str()).call()?.into_parts();
        let total = head
            .headers
            .get("Content-Length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        let mut file = std::fs::File::create(local_file)?;
        let mut reader = body.into_reader();
        let mut buffer = vec![0; 2 * 1024 * 1024];
        let (mut done, mut last) = (0u64, 0i16);
        loop {
            let size = reader.read(&mut buffer)?;
            if size == 0 {
                break;
            }
            file.write_all(&buffer[..size])?;
            done += size as u64;
            if let (Some(total), Some(progress)) = (total, &progress) {
                let step = (done as f64 / total as f64 * 20.0).floor() as i16 * 5;
                if step > last {
                    last = step;
                    let _ = progress.send(step);
                }
            }
        }
        Ok(())
    }
}
