import React, { useEffect, useMemo, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { useCanvas, useTheme } from "../theme";

/** A vanilla HTML/CSS/JS/SVG/Canvas/WebGL motion page as a layer of the timeline.
 * The page lives in public/html/ and exposes `window.renderFrame(seconds)`; this
 * component seeks it to the scene's clock on every frame and holds the render
 * until the page reports it has drawn, so CSS animations driven through the Web
 * Animations API, canvas drawing and shaders all land on exact frames.
 *
 * The film's theme (palette, face names, backdrop) and its font files (public/fonts/fonts.json,
 * written by video_project from the look) are passed to the page as props.theme and props.fonts,
 * so a page sets type in the scenes' own faces and colours; props you pass override them.
 *
 * The page is laid out in the same units as the rest of the film (short side
 * 1080), so use viewport units or measure `innerWidth`/`innerHeight`. Props reach
 * the page as `window.__PROPS__`, inlined ahead of the page's own scripts (so there
 * is no URL length limit and start-up code can read them); relative files keep
 * resolving because the document is given a `<base>`. For a transparent layer have
 * the page leave its background unpainted when `props.transparent` is true. */
export const HtmlMotion: React.FC<{ src: string; props?: Record<string, unknown>; from?: number; speed?: number; style?: React.CSSProperties }> = ({ src, props, from = 0, speed = 1, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height } = useCanvas();
  const theme = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [fonts, setFonts] = useState<Record<string, Array<{ url: string; weight: number }>> | null>(null);
  const loadHandle = useRef<number | null>(null);
  if (loadHandle.current === null) loadHandle.current = delayRender(`html motion ${src}`, { timeoutInMilliseconds: 90000 });
  useEffect(() => {
    const absolute = (path: string) => new URL(staticFile(path), window.location.href).href;
    fetch(staticFile("fonts/fonts.json")).then((response) => (response.ok ? response.json() : {}), () => ({})).then((map: Record<string, Array<{ weight: number; file: string }>>) => {
      setFonts(Object.fromEntries(Object.entries(map).map(([family, files]) => [family, files.map((entry) => ({ url: absolute(`fonts/${entry.file}`), weight: entry.weight }))])));
    });
  }, []);
  const propsKey = JSON.stringify(props ?? {});   // inline prop objects change identity every render; the page must not reload for that
  const merged = useMemo(() => ({ theme, fonts: fonts ?? {}, ...JSON.parse(propsKey) }), [theme, fonts, propsKey]);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    if (!fonts) return;                             // one fetch, with the film's font files already known
    let alive = true;
    const base = new URL(staticFile(src), window.location.href).href;
    fetch(base).then((response) => { if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`); return response.text(); }).then((html) => {
      if (!alive) return;
      const inject = `<base href="${base}"><script>window.__PROPS__=${JSON.stringify(merged).replace(/</g, "\\u003c")}</script>`;
      setDoc(/^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${inject}`) : inject + html);
    }).catch(cancelRender);
    return () => { alive = false; };
  }, [src, merged, fonts]);
  const onLoad = () => {
    const win = frameRef.current?.contentWindow as (Window & { renderFrame?: (seconds: number) => unknown }) | null;
    if (!win || typeof win.renderFrame !== "function") return cancelRender(new Error(`${src} must expose window.renderFrame(seconds)`));
    win.document.body.classList.add("exporting");   // stops any live preview loop in the page; only renderFrame draws
    win.document.fonts.ready.then(() => { setReady(true); continueRender(loadHandle.current!); }, cancelRender);
  };
  useEffect(() => {
    if (!ready) return;
    const win = frameRef.current!.contentWindow as Window & { renderFrame: (seconds: number) => unknown };
    const handle = delayRender(`html motion frame ${frame}`, { timeoutInMilliseconds: 60000 });
    Promise.resolve(win.renderFrame(from + (frame / fps) * speed)).then(() => continueRender(handle), cancelRender);
  }, [ready, frame, fps, from, speed]);
  if (!fonts || doc === null) return null;
  return <iframe ref={frameRef} srcDoc={doc} onLoad={onLoad} title={src} style={{ position: "absolute", left: 0, top: 0, width, height, border: 0, background: "transparent", colorScheme: "normal", ...style }} />;
};
