# Windows port notes

Status: experimental Windows 10/11 x64 port. The spider model, motion, gait, patrol, and routing algorithms are shared with macOS. This branch contains no Tachikoma preview code.

## Coordinate decision

Use the primary monitor's DPI scale as one reference for the entire desktop:

- Native monitor, cursor and hook event coordinates are physical pixels.
- Shared desktop coordinates equal physical coordinates divided by the primary scale.
- Window placement multiplies coordinates by that same scale and rounds once.
- The pet host applies CSS `zoom = primaryScale / window.devicePixelRatio` to compensate for the current monitor's WebView2 DPI. The control panel keeps native DPI scaling.

Per-monitor division of global origins would break adjacency on mixed-DPI desktops. A shared reference preserves negative origins, shared edges, and the existing navigation rules. The tradeoff is that the pet keeps a consistent physical-pixel size rather than a consistent physical size in millimetres. A primary-monitor DPI change refreshes the layout and may reposition the pet.

`SetWindowPos` moves and resizes the undecorated viewport in one operation with `SWP_NOACTIVATE`. Mouse input passes through the overlay. The main window stays topmost; exclusive fullscreen and protected system desktops are outside this port's scope.

## Input decision

A dedicated Windows thread owns a `WH_MOUSE_LL` hook and message loop. The callback checks Ctrl during left-button and mouse-move events, rejects injected events and Araneae root windows, and distinguishes clicks from drags. It always returns `CallNextHookEx` so the underlying application receives the same input. No keyboard hook is installed.

Completed clicks are sent through a bounded, nonblocking channel. A separate worker checks visibility, pause state and work-area bounds before emitting the existing `pet-destination` event. The shared frontend enforces the cross-display setting and preserves the selected behavior mode. If the channel is full, the click command is dropped rather than delaying OS input. Shutdown posts `WM_QUIT`, removes the hook, and joins both workers.

## Build and validation

Use `npm run desktop:build:windows` on a Windows x64 MSVC host. The platform configuration selects NSIS and the existing app icon in ICO format, installs for the current user, and downloads/updates WebView2 if required. The Windows workflow produces a temporary Actions artifact and does not publish a release.

Local checks cover JavaScript syntax, desktop routing/cropping/clock rules, native settings and click gesture recognition, and macOS compilation. Windows-target Rust type checking is also performed using a temporary diagnostic copy without resource generation; it does not validate the production Tauri build, installer, or Windows runtime.

The existing `node scripts/check-desktop-motion.mjs` suite fails at `manual-horizontal-slow: patrol took over a manual destination`. The identical assertion fails on the unchanged `a9d6c25` baseline. This port does not alter the controller or weaken that assertion. `npm run desktop:test` retains the failing integration check. The new Windows workflow runs the scoped routing, clock, crop and native checks; it does not run this known-failing full motion suite.

Windows hardware checks remain required: transparency and shadows; input pass-through; Ctrl-click versus dragging and control-panel clicks; pause/hide and observe after arrival; cross-display lock; horizontal/vertical/negative-origin layouts; mixed 100%/125%/200% scaling; primary display changes and hot-plugging; tray behavior; borderless fullscreen; and install/uninstall on a clean Windows machine.

References: [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows), [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/), [Microsoft low-level mouse hook](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc).
