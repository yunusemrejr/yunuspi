// Local, pinned font files (OFL, @fontsource, latin subset). Rendering never
// depends on network fonts or on whatever happens to be installed on the host.
import "@fontsource/bricolage-grotesque/latin-700.css";
import "@fontsource/bricolage-grotesque/latin-800.css";
import "@fontsource/hanken-grotesk/latin-400.css";
import "@fontsource/hanken-grotesk/latin-600.css";
import "@fontsource/hanken-grotesk/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { continueRender, delayRender } from "remotion";

const handle = delayRender("Loading fonts");
const faces = ["700 40px 'Bricolage Grotesque'", "800 40px 'Bricolage Grotesque'", "400 40px 'Hanken Grotesk'", "600 40px 'Hanken Grotesk'", "700 40px 'Hanken Grotesk'", "400 40px 'IBM Plex Mono'", "500 40px 'IBM Plex Mono'"];
Promise.all(faces.map((face) => document.fonts.load(face))).then(() => continueRender(handle), () => continueRender(handle));
