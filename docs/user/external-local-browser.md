# External local browser backend

T3 Code Desktop can run preview tabs in a visible Chrome-family browser on the Desktop machine
instead of an Electron `<webview>`:

```bash
T3CODE_BROWSER_BACKEND=external-local vp run dev:desktop
```

The Desktop process detects Helium, Google Chrome, or Chromium. Override detection and the profile
location when needed:

```bash
T3CODE_EXTERNAL_BROWSER_EXECUTABLE=/Applications/Helium.app/Contents/MacOS/Helium \
T3CODE_EXTERNAL_BROWSER_USER_DATA_DIR=/path/to/t3-browser-profile \
T3CODE_EXTERNAL_BROWSER_PROFILE_DIRECTORY='Profile 42' \
T3CODE_BROWSER_BACKEND=external-local \
vp run dev:desktop
```

Without a profile override, each T3 environment gets a stable directory under
`<T3 state>/browser-profiles/`. This is deliberately not the browser's normal user profile: current
Chromium builds reject remote-debugging against their default data directory. Cookies, storage,
logins, extensions, and other browser state persist in the T3-owned profile across app restarts.
Overrides that point at a known Chrome, Chromium, or Helium default profile are rejected for the same
reason. `T3CODE_EXTERNAL_BROWSER_PROFILE_DIRECTORY` selects a named profile inside the dedicated
user-data directory. To reuse an existing browser profile, copy it into a separate T3-owned
user-data directory first; never point the override at the browser's live user-data root.

CDP listens on an operating-system-assigned port bound to `127.0.0.1`. The endpoint stays entirely
inside Desktop; it is not sent to the T3 server, T3 Connect, a tailnet, or a LAN interface. If T3
Desktop exits, the visible external browser is left open for manual use. The next Desktop process
reconnects through the profile's `DevToolsActivePort` file instead of spawning a duplicate.

T3-created pages have explicit preview-tab-to-CDP-target mappings. Popups and tabs opened manually
in the same dedicated browser profile remain unmanaged in v1; T3 never adopts an arbitrary page.
Closing or crashing a managed page marks it unavailable, and the next preview operation recreates a
page in the same persistent profile. Desktop reconnects to a browser left running across a restart,
but previously managed pages become manual pages; a subsequent preview operation opens a newly
managed page rather than guessing which existing page to adopt.

The in-app Browser panel becomes a status/control surface with **Focus Browser** and **Open
DevTools** controls. The actual page and all manual interaction live in the external browser. Element
picking, native picture-in-picture, the in-app preview mini-player, the embedded device-toolbar
viewport, and a live in-panel mirror remain embedded-only features. External automation, navigation,
screenshots, console/network diagnostics, and recording frames operate on the real page.

`external-local` always means the Desktop machine. For a remote T3 environment, a literal
`localhost` URL therefore points at Desktop—not the remote server. Existing environment URL routing
or an externally reachable/tunneled development URL must be used. This backend does not add a remote
preview gateway or proxy CDP through the server.
