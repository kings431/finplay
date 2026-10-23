# Finplay

Desktop Jellyfin client (Tauri 2 + React 19). See `HANDOFF.md` for the macOS player/build background.

## Linux runtime dependency: GStreamer "good" plugins

The desktop build renders everything (including the Live TV guide's channel
preview and any other in-webview `<video>`) through WebKitGTK's GStreamer
media backend. On a system where **`gst-plugins-good`** isn't installed,
WebKitGTK can't find `autoaudiosink` and hard-aborts its renderer process
instead of failing gracefully — the whole app window goes black and
unresponsive the moment a video element tries to play, even though it's
muted and even though the rest of the desktop (GPU, compositor) is fine.

Install it before running or packaging for Linux:

```bash
# Arch / CachyOS
sudo pacman -S gst-plugins-good

# Debian / Ubuntu
sudo apt-get install gstreamer1.0-plugins-good

# Fedora
sudo dnf install gstreamer1-plugins-good
```
