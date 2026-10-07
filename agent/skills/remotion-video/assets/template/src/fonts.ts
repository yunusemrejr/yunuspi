// Local, pinned font files (OFL, @fontsource, bundled Unicode subsets). Rendering never
// depends on network fonts or on whatever happens to be installed on the host.
import "@fontsource/bricolage-grotesque/700.css";
import "@fontsource/bricolage-grotesque/800.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { cancelRender, continueRender, delayRender } from "remotion";

const handle = delayRender("Loading fonts");
const faces = ["700 40px 'Bricolage Grotesque'", "800 40px 'Bricolage Grotesque'", "400 40px 'Hanken Grotesk'", "600 40px 'Hanken Grotesk'", "700 40px 'Hanken Grotesk'", "400 40px 'IBM Plex Mono'", "500 40px 'IBM Plex Mono'"];
Promise.all(faces.map(async (face) => { const loaded = await document.fonts.load(face); if (!loaded.length) throw new Error(`Missing font face: ${face}`); })).then(() => continueRender(handle), (error) => cancelRender(error));
