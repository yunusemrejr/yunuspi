/** desktop_session: computer use inside private virtual displays for
 * launching and testing desktop applications. Discovered on demand. */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createDesktopManager } from "./lib/desktop-session.ts";
import { canonicalMutationPath, containsPath } from "./lib/self-mutation-guard.ts";

const choices = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));

export default function desktopSession(pi: any) {
  const manager = createDesktopManager();
  pi.on("session_shutdown", () => manager.stopAll());
  pi.on("session_start", () => manager.stopAll());
  pi.registerTool({
    name: "desktop_session",
    label: "Desktop session",
    description: "Computer use in a private virtual display (Xvfb): launch desktop apps (Electron, GTK, Qt, X11) and drive them with click, drag, scroll, type and key input, then check the result with screenshots and window lists. Nothing reaches the user's own screen or input. start opens a display (default 1280x800); launch runs a shell command there (reviewed like bash); screenshot returns a PNG (and pixels for vision models) plus visible windows with geometry; windows, focus and wait (for a window title) help target input; logs shows each process's output; stop kills the display and its processes. Two sessions, twelve processes each, twenty-minute idle lease. Requires Xvfb, xdotool, xwd and ffmpeg.",
    promptGuidelines: ["For desktop GUI apps use desktop_session; for web pages use browser_session."],
    parameters: Type.Object({
      action: choices(["start", "launch", "screenshot", "click", "move", "drag", "scroll", "type", "key", "focus", "windows", "wait", "logs", "stop", "list"]),
      session: Type.Optional(Type.String({ maxLength: 40 })),
      command: Type.Optional(Type.String({ maxLength: 4000, description: "launch: shell command run with DISPLAY set, e.g. \"npm run electron\" or \"./build/app --demo\"" })),
      cwd: Type.Optional(Type.String({ maxLength: 1024, description: "launch: working directory inside the workspace" })),
      width: Type.Optional(Type.Integer({ minimum: 320, maximum: 2560 })),
      height: Type.Optional(Type.Integer({ minimum: 240, maximum: 1600 })),
      x: Type.Optional(Type.Integer({ minimum: 0, maximum: 2559 })),
      y: Type.Optional(Type.Integer({ minimum: 0, maximum: 1599 })),
      toX: Type.Optional(Type.Integer({ minimum: 0, maximum: 2559 })),
      toY: Type.Optional(Type.Integer({ minimum: 0, maximum: 1599 })),
      button: Type.Optional(choices(["left", "right", "middle"])),
      double: Type.Optional(Type.Boolean()),
      direction: Type.Optional(choices(["up", "down"])),
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      text: Type.Optional(Type.String({ maxLength: 2000 })),
      keys: Type.Optional(Type.String({ maxLength: 200, description: 'xdotool key names separated by spaces: "Return", "ctrl+s", "alt+F4"' })),
      window: Type.Optional(Type.String({ maxLength: 16 })),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
      pid: Type.Optional(Type.Integer({ minimum: 1 })),
      region: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 8 }), height: Type.Integer({ minimum: 8 }) })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      signal?.throwIfAborted();
      const cwd = ctx?.cwd || process.cwd();
      let result: any;
      switch (params.action) {
        case "start": result = await manager.start(params); break;
        case "launch": {
          const root = await fs.realpath(cwd);
          const dir = params.cwd ? canonicalMutationPath(params.cwd, root) : root;
          if (!containsPath(root, dir) || !(await fs.stat(dir).catch(() => undefined))?.isDirectory()) throw new Error("cwd must be an existing directory inside the workspace");
          result = await manager.launch({ session: params.session, command: params.command, cwd: dir });
          break;
        }
        case "screenshot": {
          result = await manager.screenshot(params);
          const content: any[] = [{ type: "text", text: JSON.stringify(result) }];
          if (ctx?.model?.input?.includes?.("image")) content.push({ type: "image", mimeType: "image/png", data: (await fs.readFile(result.path)).toString("base64") });
          else content.push({ type: "text", text: `PNG saved at ${path.basename(result.path)}; this model does not take images: use image_ocr for text or a vision-capable child for layout.` });
          return { content, details: result };
        }
        case "windows": result = { windows: await manager.windows(params.session) }; break;
        case "wait": result = await manager.wait(params); break;
        case "logs": result = manager.logs(params); break;
        case "stop": result = await manager.stop(params.session); break;
        case "list": result = manager.list(); break;
        default: result = await manager.input(params);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
