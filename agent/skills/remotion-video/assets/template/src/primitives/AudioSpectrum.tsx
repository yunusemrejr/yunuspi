import React from "react";
import { staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import { useTheme } from "../theme";

/** Bars driven by the actual audio (music, narration or an effect) at each
 * frame, so visuals pulse with the sound. `src` is a public/ path such as
 * "audio/music.wav"; `offsetSeconds` aligns it with where that audio plays. */
export const AudioSpectrum: React.FC<{ src: string; bars?: number; width?: number; height?: number; color?: string; mirror?: boolean; offsetSeconds?: number; gain?: number }> = ({ src, bars = 48, width = 1200, height = 220, color, mirror = true, offsetSeconds = 0, gain = 1.6 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const audio = useAudioData(staticFile(src));
  if (!audio) return null;
  const samples = 2 ** Math.ceil(Math.log2(Math.max(16, bars * 2)));
  const values = visualizeAudio({ fps, frame: Math.max(0, frame + Math.round(offsetSeconds * fps)), audioData: audio, numberOfSamples: samples, smoothing: true }).slice(0, bars);
  const barWidth = width / bars;
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      {values.map((v, i) => {
        const h = Math.max(2, Math.min(1, Math.sqrt(v) * gain) * (mirror ? height / 2 : height));
        const x = i * barWidth + barWidth * 0.15;
        return <rect key={i} x={x} y={mirror ? height / 2 - h : height - h} width={barWidth * 0.7} height={mirror ? h * 2 : h} rx={barWidth * 0.3} fill={color ?? theme.accent} opacity={0.35 + 0.65 * Math.min(1, v * 4)} />;
      })}
    </svg>
  );
};
