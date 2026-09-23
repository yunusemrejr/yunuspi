// Local, pinned font files (OFL, @fontsource). Rendering never depends on
// network fonts or on whatever happens to be installed on the host.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/800.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import { continueRender, delayRender } from "remotion";

const handle = delayRender("Loading fonts");
const faces = ["400 40px Inter", "600 40px Inter", "800 40px Inter", "600 40px Fraunces", "700 40px Fraunces", "400 40px 'JetBrains Mono'", "700 40px 'JetBrains Mono'"];
Promise.all(faces.map((face) => document.fonts.load(face))).then(() => continueRender(handle), () => continueRender(handle));
