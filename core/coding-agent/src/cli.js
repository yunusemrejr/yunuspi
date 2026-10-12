#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--core-info" || args[0] === "--version" || args[0] === "-v")) {
    const core = JSON.parse(readFileSync(new URL("../../build.json", import.meta.url), "utf8"));
    const product = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    if (args[0] === "--core-info") console.log(JSON.stringify({ product: { name: "YunusPi", version: product.version }, core }, null, 2));
    else console.log(`YunusPi ${product.version} (core ${core.version}; origin Pi ${core.forkOrigin.version})`);
} else {
    // Normal interactive launches are desktop sessions. Workers, scripts and
    // piped prompts retain the structured headless CLI without loading Electron.
    const gui = args.includes('--gui') || (process.stdin.isTTY && process.stdout.isTTY && (args.length === 0 || args.every(arg => !arg.startsWith('-'))));
    if (gui) {
        const { launchDesktop } = await import('../../../desktop/launch.mjs');
        launchDesktop(args.filter(arg => arg !== '--gui'));
    } else {
    const [{ setupCli }, { main }] = await Promise.all([import('./cli/setup.js'), import('./main.js')]);
    setupCli();
    // Terminal flags remain useful for automation, but no public CLI path
    // implicitly starts the retired terminal frontend.
    const terminalInteractive = process.stdin.isTTY && process.stdout.isTTY && !args.includes('--mode') && !args.includes('--print') && !args.includes('-p');
    main(terminalInteractive ? [...args, '--print'] : args).catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
    }
}
