import React from "react";
import { AbsoluteFill } from "remotion";
import { BlenderShot, Heading, ShotNote, Stage } from "../primitives";
import type { ShotMode } from "../primitives/BlenderShot";
import { useSafe, useTheme } from "../theme";
import { cue, cueOr, toFrames, type TimedScene } from "../timeline";

/** Default label heights (up, down, further up, further down) so notes on nearby features do not share a line. */
const STAGGER = [-150, 130, -240, 220];

type Note = { anchor: string; text: string; sub?: string; cue?: string; dx?: number; dy?: number };

/** A Blender shot (video_shot) on the look's stage, with 2D annotations pinned to named 3D
 * features. `notes[].cue` names a scene cue (seconds, in video.json cues) that starts that
 * note, so callouts land on the spoken words. The optional title sits bottom-left; leave
 * room for it with the shot's `align` or the shot's own `offset`. */
export const ShotScene: React.FC<{ scene: TimedScene; shot: string; kicker?: string; title?: string; subtitle?: string; notes?: Note[]; mode?: ShotMode; speed?: number; offset?: number; fit?: "contain" | "cover"; align?: [number, number]; scale?: number; backdrop?: boolean }> = ({
  scene, shot, kicker, title, subtitle, notes = [], mode, speed, offset, fit, align, scale, backdrop = true,
}) => {
  const safe = useSafe();
  const theme = useTheme();
  return (
    <AbsoluteFill>
      <Stage seed={scene.index + 5} backdrop={backdrop}>{null}</Stage>
      <BlenderShot shot={shot} mode={mode} speed={speed} offset={offset} fit={fit} align={align} scale={scale}>
        {notes.map((note, i) => <ShotNote key={i} anchor={note.anchor} text={note.text} sub={note.sub} dx={note.dx} dy={note.dy ?? STAGGER[i % STAGGER.length]} at={note.cue ? cue(scene, note.cue) : toFrames(0.6 + i * 0.9)} />)}
      </BlenderShot>
      {title ? (
        <AbsoluteFill style={{ padding: safe }}>
          <div style={{ position: "relative", width: "100%", height: "100%", fontFamily: theme.text, color: theme.ink }}>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
              <Heading kicker={kicker} title={title} subtitle={subtitle} at={cueOr(scene, "title", 0.4)} subtitleAt={cueOr(scene, "subtitle", 1.1)} size={96} />
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
