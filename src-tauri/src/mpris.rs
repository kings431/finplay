//! Publishes playback over MPRIS so media keys, headset buttons and the
//! KDE or GNOME media widgets can see and control Finplay. A no-op off Linux.

#[derive(Clone, Copy, Debug)]
pub enum Control {
    PlayPause,
    Play,
    Pause,
    Stop,
    Next,
    SeekBy(f64),
    SeekTo(f64),
}

#[derive(Clone, Default)]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub art_url: String,
    pub can_next: bool,
}

pub enum Update {
    Track(Track),
    Progress { time: f64, duration: f64, paused: bool },
    Stopped,
}

pub struct Mpris {
    #[cfg(target_os = "linux")]
    tx: std::sync::mpsc::Sender<Update>,
}

impl Mpris {
    pub fn start(control: impl Fn(Control) + Send + Sync + 'static) -> Self {
        #[cfg(target_os = "linux")]
        {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = linux::serve(rx, Box::new(control));
            });
            Self { tx }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = control;
            Self {}
        }
    }

    pub fn update(&self, update: Update) {
        #[cfg(target_os = "linux")]
        let _ = self.tx.send(update);
        #[cfg(not(target_os = "linux"))]
        let _ = update;
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Control, Track, Update};
    use dbus::arg::{PropMap, Variant};
    use dbus::blocking::stdintf::org_freedesktop_dbus::{PropertiesPropertiesChanged, RequestNameReply};
    use dbus::blocking::Connection;
    use dbus::channel::{MatchingReceiver, Sender};
    use dbus::message::{MatchRule, SignalArgs};
    use dbus::strings::{Interface, Member};
    use dbus_crossroads::{Crossroads, IfaceBuilder};
    use std::collections::HashMap;
    use std::sync::mpsc::{Receiver, TryRecvError};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    const PATH: &str = "/org/mpris/MediaPlayer2";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";

    #[derive(Default)]
    struct Now {
        track: Option<Track>,
        time: f64,
        duration: f64,
        paused: bool,
    }

    impl Now {
        fn status(&self) -> &'static str {
            match &self.track {
                None => "Stopped",
                Some(_) if self.paused => "Paused",
                Some(_) => "Playing",
            }
        }

        fn metadata(&self) -> PropMap {
            let mut map: PropMap = HashMap::new();
            let Some(track) = &self.track else {
                map.insert(
                    "mpris:trackid".into(),
                    Variant(Box::new(dbus::Path::from("/org/mpris/MediaPlayer2/TrackList/NoTrack"))),
                );
                return map;
            };
            map.insert("mpris:trackid".into(), Variant(Box::new(dbus::Path::from("/app/finplay/track"))));
            map.insert("xesam:title".into(), Variant(Box::new(track.title.clone())));
            if !track.artist.is_empty() {
                map.insert("xesam:artist".into(), Variant(Box::new(vec![track.artist.clone()])));
            }
            if !track.art_url.is_empty() {
                map.insert("mpris:artUrl".into(), Variant(Box::new(track.art_url.clone())));
            }
            if self.duration > 0.0 {
                map.insert("mpris:length".into(), Variant(Box::new((self.duration * 1e6) as i64)));
            }
            map
        }

        fn player_props(&self) -> PropMap {
            let loaded = self.track.is_some();
            let mut props: PropMap = HashMap::new();
            props.insert("PlaybackStatus".into(), Variant(Box::new(self.status().to_string())));
            props.insert("Metadata".into(), Variant(Box::new(self.metadata())));
            props.insert(
                "CanGoNext".into(),
                Variant(Box::new(self.track.as_ref().is_some_and(|track| track.can_next))),
            );
            for name in ["CanPlay", "CanPause", "CanSeek"] {
                props.insert(name.into(), Variant(Box::new(loaded)));
            }
            props
        }
    }

    struct Shared {
        now: Mutex<Now>,
        control: Box<dyn Fn(Control) + Send + Sync>,
    }

    type Ctx = Arc<Shared>;

    fn now(ctx: &Ctx) -> MutexGuard<'_, Now> {
        ctx.now.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn act(ctx: &Ctx, control: Control) -> Result<(), dbus::MethodErr> {
        (ctx.control)(control);
        Ok(())
    }

    pub fn serve(rx: Receiver<Update>, control: Box<dyn Fn(Control) + Send + Sync>) -> Result<(), dbus::Error> {
        let connection = Connection::new_session()?;
        let owned = matches!(
            connection.request_name("org.mpris.MediaPlayer2.finplay", false, false, true),
            Ok(RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner)
        );
        if !owned {
            let name = format!("org.mpris.MediaPlayer2.finplay.instance{}", std::process::id());
            connection.request_name(name, false, false, true)?;
        }

        let ctx: Ctx = Arc::new(Shared { now: Mutex::new(Now::default()), control });
        let mut cr = Crossroads::new();
        let root = cr.register("org.mpris.MediaPlayer2", |b: &mut IfaceBuilder<Ctx>| {
            b.property("Identity").get(|_, _| Ok("Finplay".to_string()));
            b.property("CanQuit").get(|_, _| Ok(false));
            b.property("CanRaise").get(|_, _| Ok(false));
            b.property("HasTrackList").get(|_, _| Ok(false));
            b.property("SupportedUriSchemes").get(|_, _| Ok(Vec::<String>::new()));
            b.property("SupportedMimeTypes").get(|_, _| Ok(Vec::<String>::new()));
            b.method("Raise", (), (), |_, _, _: ()| Ok(()));
            b.method("Quit", (), (), |_, _, _: ()| Ok(()));
        });
        let player = cr.register(PLAYER, |b: &mut IfaceBuilder<Ctx>| {
            b.property("PlaybackStatus").get(|_, ctx| Ok(now(ctx).status().to_string()));
            b.property("Metadata").get(|_, ctx| Ok(now(ctx).metadata()));
            b.property("Position").get(|_, ctx| Ok((now(ctx).time * 1e6) as i64));
            b.property("Rate").get(|_, _| Ok(1.0f64));
            b.property("MinimumRate").get(|_, _| Ok(1.0f64));
            b.property("MaximumRate").get(|_, _| Ok(1.0f64));
            b.property("Volume").get(|_, _| Ok(1.0f64));
            b.property("CanGoNext").get(|_, ctx| Ok(now(ctx).track.as_ref().is_some_and(|track| track.can_next)));
            b.property("CanGoPrevious").get(|_, _| Ok(false));
            b.property("CanPlay").get(|_, ctx| Ok(now(ctx).track.is_some()));
            b.property("CanPause").get(|_, ctx| Ok(now(ctx).track.is_some()));
            b.property("CanSeek").get(|_, ctx| Ok(now(ctx).track.is_some()));
            b.property("CanControl").get(|_, _| Ok(true));
            b.method("PlayPause", (), (), |_, ctx, _: ()| act(ctx, Control::PlayPause));
            b.method("Play", (), (), |_, ctx, _: ()| act(ctx, Control::Play));
            b.method("Pause", (), (), |_, ctx, _: ()| act(ctx, Control::Pause));
            b.method("Stop", (), (), |_, ctx, _: ()| act(ctx, Control::Stop));
            b.method("Next", (), (), |_, ctx, _: ()| act(ctx, Control::Next));
            b.method("Previous", (), (), |_, _, _: ()| Ok(()));
            b.method("Seek", ("Offset",), (), |_, ctx, (offset,): (i64,)| {
                act(ctx, Control::SeekBy(offset as f64 / 1e6))
            });
            b.method("SetPosition", ("TrackId", "Position"), (), |_, ctx, (_, position): (dbus::Path<'static>, i64)| {
                act(ctx, Control::SeekTo(position as f64 / 1e6))
            });
            b.method("OpenUri", ("Uri",), (), |_, _, _: (String,)| Ok(()));
            b.signal::<(i64,), _>("Seeked", ("Position",));
        });
        cr.insert(PATH, &[root, player], Arc::clone(&ctx));
        connection.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |message, conn| {
                let _ = cr.handle_message(message, conn);
                true
            }),
        );

        let path = dbus::Path::from(PATH);
        let mut last_progress = Instant::now();
        loop {
            connection.process(Duration::from_millis(200))?;
            let mut changed = false;
            let mut seeked = None;
            loop {
                let update = match rx.try_recv() {
                    Ok(update) => update,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Ok(()),
                };
                let mut state = now(&ctx);
                match update {
                    Update::Track(track) => {
                        *state = Now { track: Some(track), ..Now::default() };
                        last_progress = Instant::now();
                        changed = true;
                    }
                    Update::Progress { time, duration, paused } => {
                        if state.track.is_none() {
                            continue;
                        }
                        let expected = state.time + if state.paused { 0.0 } else { last_progress.elapsed().as_secs_f64() };
                        if (time - expected).abs() > 3.0 {
                            seeked = Some(time);
                        }
                        if paused != state.paused || (duration - state.duration).abs() > 0.5 {
                            changed = true;
                        }
                        state.time = time;
                        state.duration = duration;
                        state.paused = paused;
                        last_progress = Instant::now();
                    }
                    Update::Stopped => {
                        if state.track.take().is_some() {
                            changed = true;
                        }
                    }
                }
            }
            if changed {
                let signal = PropertiesPropertiesChanged {
                    interface_name: PLAYER.into(),
                    changed_properties: now(&ctx).player_props(),
                    invalidated_properties: Vec::new(),
                };
                let _ = connection.send(signal.to_emit_message(&path));
            }
            if let Some(time) = seeked {
                let message = dbus::Message::signal(&path, &Interface::from(PLAYER), &Member::from("Seeked"))
                    .append1((time * 1e6) as i64);
                let _ = connection.send(message);
            }
        }
    }
}
