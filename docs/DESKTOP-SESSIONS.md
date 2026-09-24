# Desktop sessions: computer use in a virtual display

`desktop_session` lets an agent run and test desktop applications (Electron, GTK, Qt, Tk, plain X11) the way a person would: launch the app, look at it, click, type, press keys and look again. Everything happens in a private Xvfb display that the session owns, so nothing reaches the user's screen, clipboard, keyboard or mouse.

| Action | Does |
| --- | --- |
| `start` | Opens a virtual display (default 1280×800, up to 2560×1600) and returns a session id |
| `launch` | Runs a shell command with `DISPLAY` set from a workspace directory, in its own process group, and reports the windows it opened |
| `screenshot` | PNG of the display or a region, the visible windows with titles and geometry, and pixels for vision-capable models |
| `click`, `move`, `drag`, `scroll` | Pointer input in display pixels |
| `type`, `key` | Literal text, or key names such as `Return`, `ctrl+s`, `alt+F4` |
| `windows`, `focus`, `wait` | List windows, focus one, or wait for a window whose title contains some text |
| `logs` | Recent stdout/stderr of each launched process and whether it is still running |
| `stop`, `list` | Kill a session's processes and display; list open sessions |

```js
tool_search({ names: ["desktop_session"] })   // prompts about desktop, Electron, GTK or Qt apps enable it automatically
desktop_session({ action: "start" })
desktop_session({ action: "launch", session: "desk-1a2b3c", command: "npm run start" })
desktop_session({ action: "wait", session: "desk-1a2b3c", title: "My App" })
desktop_session({ action: "screenshot", session: "desk-1a2b3c" })
desktop_session({ action: "click", session: "desk-1a2b3c", x: 640, y: 420 })
desktop_session({ action: "key", session: "desk-1a2b3c", keys: "ctrl+s" })
desktop_session({ action: "stop", session: "desk-1a2b3c" })
```

## Boundaries

- Launch commands are shell commands with the same trust as `bash`, and the filesystem-safety hook reviews them the same way: destructive commands are blocked before they run.
- At most two sessions with twelve running processes each; a session idle for twenty minutes is stopped, and all sessions stop when the agent session ends. Every launched process dies with its session.
- Requires `Xvfb`, `xdotool`, `xwd` (x11-apps) and `ffmpeg` on Linux (`sudo apt-get install xvfb xdotool x11-apps ffmpeg`). Missing tools are reported with the install command. Wayland-only or GPU-dependent apps may not render under Xvfb; Windows uses WSL2 and macOS a Linux VM, as for the rest of YunusPi.
- Screenshots show pixels, not semantics: combine them with `image_ocr` for text and with the app's own logs. A screenshot of a working screen does not prove the underlying behavior is correct.
