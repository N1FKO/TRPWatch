# Watch — an interface for Trunk Recorder Pro (macOS)

Recorded Trunk Recorder Pro calls with their transcripts, from Apple's on-device
SpeechTranscriber. Two pieces:

- `interface/` — a TRP interface (listen access) that looks and feels like TRP's
  Listen page: the display with its buttons, Recent, and the Calls and Talkgroups
  tabs with the same talkgroup chooser. Each wanted call is sent to the helper, and
  its transcript is shown in the display and under the call in the list.
- `helper/` — `trp-watch-helper`, a small Swift command-line program. It listens on
  loopback port 8765 and returns plain SpeechTranscriber text for each call.


## Licenses

- `helper/` (trp-watch-helper): MIT, see `helper/LICENSE`. It's original code.
- `interface/` (the Watch page): GPL-3.0-or-later, see `interface/LICENSE`. It includes
  Trunk Recorder Pro's stylesheet, and selection logic adapted from TRP's Listen page,
  which are GPL-3.0-or-later.

## How a call flows

1. TRP sends `concluded` for a recorded call.
2. If "Transcribe new calls" is on, the call is in the chosen system and talkgroup filter,
   it's at least the minimum length, and it isn't encrypted, the page fetches
   `/calls/<path>.wav` from TRP. That's the same origin, so TRP needs no extra settings.
3. The page sends those bytes to `POST http://127.0.0.1:8765/transcribe?path=<path>`.
4. The helper runs one call at a time, with up to 50 waiting, and returns
   `{status, text, confidence, words, audioSeconds, elapsedMs, ...}`.
5. The page shows the text, and keeps the last 2000 transcripts in localStorage.

Clicking a call in the list shows it in the display, and transcribes it if it hasn't
been transcribed yet.

## The page, next to Listen

The layout, the talkgroup chooser and how calls are selected all follow TRP's Listen
page. Systems and talkgroups switch on and off the same way, the Groups and Tags chips
work the same, and so do Hold sys, Hold TG, Avoid and Avoid for 30/60/120 min. Here
they decide which calls get transcribed. The other differences:

| Listen | Watch |
|---|---|
| Live feed on/off | Live transcripts on/off: new calls in your selection are transcribed |
| Pause | Pause: stops sending calls to the helper; calls queue up |
| Replay, Skip | Play (this call's audio), Copy (its transcript) |
| Q, missed | Calls waiting for the helper, and calls dropped from a full queue (50) |

Watch keeps its own selection, because a browser keeps each port's storage apart, so
it can't read Listen's.

`interface/trp.css` is TRP's own stylesheet (`web/src/styles.css`), copied unchanged so
the page matches. The commit it came from is noted at the top of the file. To follow a
TRP restyle, copy that file again. Watch's own rules are in `watch.css`.

## Build

```sh
git clone https://github.com/N1FKO/TRPWatch.git
cd TRPWatch/helper
swift build -c release
```

## Test the speech side alone (no server)

In these examples, `/path/to/call.wav` stands for any call TRP has recorded. By default
TRP saves them under `~/TrunkRecorderPro/<system>/<year>/<month>/<day>/`.

```sh
.build/release/trp-watch-helper --transcribe /path/to/call.wav
```

This prints one JSON line for each `--transcribe` file.

## Run the helper

```sh
.build/release/trp-watch-helper            # --port 8765 --locale en-US by default
```

In another window:

```sh
curl -s http://127.0.0.1:8765/health
curl -s -X POST 'http://127.0.0.1:8765/transcribe?path=test' -H 'Content-Type: audio/wav' \
  --data-binary @/path/to/call.wav
curl -s -X POST http://127.0.0.1:8765/transcribe -H 'Content-Type: application/json' \
  -d '{"file":"/path/to/call.wav"}'
```

The helper binds only to the loopback interface. Browser pages are allowed from
`http://localhost:*` and `http://127.0.0.1:*`. Other origins get 403, unless you add
them with `--allow-origin`. Requests that send no Origin header, such as curl, are allowed.

## Add the interface to TRP

On TRP's Interfaces page, choose "Add a folder…" and pick the `interface` folder
in this repo. You can also run `trunk-pro interface add "$PWD/interface"` from the top of
the repo. TRP serves it on the next free port, with listen access. Open that port's page.
Files are read on each request, so to pick up changes, edit and reload.

## Keep the helper running (optional, after testing)

Run this from the top of the repo. It fills in the repo and home paths in the plist as
it copies it.

```sh
sed -e "s#@REPO@#$PWD#" -e "s#@HOME@#$HOME#g" \
  helper/launchd/org.n1fko.trp-watch-helper.plist \
  > ~/Library/LaunchAgents/org.n1fko.trp-watch-helper.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.n1fko.trp-watch-helper.plist
tail -f ~/Library/Logs/trp-watch-helper.log
```

To remove it: `launchctl bootout gui/$(id -u)/org.n1fko.trp-watch-helper`.

## Errors returned

`missing_audio`, `bad_audio`, `queue_full`, `transcriber_unavailable`, `unsupported_locale`,
`assets_not_installed`, `transcription_failed`, `bad_request`, `io_error`.
