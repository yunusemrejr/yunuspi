import React from "react";
import { luminance, useTheme } from "../theme";

/** One colour grade over everything inside it (2D scenes, rendered 3D shots,
 * embedded pages), so mixed sources read as one film. Values are neutral at their
 * defaults. By default the split-tone comes from the look's own palette (accent2
 * in the shadows, accent in the highlights, at low strength), so each film's grade
 * is its own and not a stock teal-and-orange. Pure per frame: no noise, no state.
 *
 * exposure in stops; contrast/saturation multipliers; temperature -1 (cool)..1
 * (warm); lift/gamma/gain per ASC-CDL style; split 0..1 scales the tone tint;
 * vignette 0..1 darkens (dark looks) or lifts (light looks) the corners. */
export const Grade: React.FC<{ exposure?: number; contrast?: number; saturation?: number; temperature?: number; lift?: number; gamma?: number; gain?: number; shadows?: string; highlights?: string; split?: number; vignette?: number; id?: string; children: React.ReactNode }> = ({
  exposure = 0, contrast = 1, saturation = 1, temperature = 0, lift = 0, gamma = 1, gain = 1, shadows, highlights, split = 0.3, vignette = 0, id = "grade", children,
}) => {
  const theme = useTheme();
  const rgb = (hex: string): [number, number, number] => { const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number]; };
  const shadow = rgb(shadows ?? theme.accent2), highlight = rgb(highlights ?? theme.accent);
  // Five-point curves per channel: identity plus a push toward the shadow tint low and the highlight tint high.
  const curve = (channel: 0 | 1 | 2) => [0, 0.25, 0.5, 0.75, 1].map((x) => Math.min(1, Math.max(0, x + split * 0.35 * ((1 - x) ** 2 * (shadow[channel] - 0.5) + x ** 2 * (highlight[channel] - 0.5))))).map((v) => v.toFixed(4)).join(" ");
  const slope = 2 ** exposure * gain;
  const warm = temperature * 0.12;
  const dark = luminance(theme.background) < 0.4;
  const light = vignette ? (dark ? `radial-gradient(ellipse at 50% 46%, transparent ${70 - vignette * 25}%, rgba(0,0,0,${0.55 * vignette}) 100%)` : `radial-gradient(ellipse at 50% 46%, transparent ${72 - vignette * 20}%, rgba(20,16,10,${0.22 * vignette}) 100%)`) : "";
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
          <feComponentTransfer>
            <feFuncR type="gamma" amplitude={slope} exponent={1 / gamma} offset={lift} />
            <feFuncG type="gamma" amplitude={slope} exponent={1 / gamma} offset={lift} />
            <feFuncB type="gamma" amplitude={slope} exponent={1 / gamma} offset={lift} />
          </feComponentTransfer>
          <feComponentTransfer>
            <feFuncR type="linear" slope={contrast} intercept={0.5 - 0.5 * contrast} />
            <feFuncG type="linear" slope={contrast} intercept={0.5 - 0.5 * contrast} />
            <feFuncB type="linear" slope={contrast} intercept={0.5 - 0.5 * contrast} />
          </feComponentTransfer>
          <feColorMatrix type="saturate" values={String(saturation)} />
          <feColorMatrix type="matrix" values={`${1 + warm} 0 0 0 0  0 ${1 + warm * 0.15} 0 0 0  0 0 ${1 - warm} 0 0  0 0 0 1 0`} />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={curve(0)} />
            <feFuncG type="table" tableValues={curve(1)} />
            <feFuncB type="table" tableValues={curve(2)} />
          </feComponentTransfer>
        </filter>
      </svg>
      <div style={{ position: "absolute", inset: 0, filter: `url(#${id})` }}>{children}</div>
      {light ? <div style={{ position: "absolute", inset: 0, background: light, pointerEvents: "none" }} /> : null}
    </div>
  );
};
