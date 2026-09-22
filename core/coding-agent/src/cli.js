#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { setupCli } from "./cli/setup.js";
import { main } from "./main.js";
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--core-info" || args[0] === "--version" || args[0] === "-v")) {
    const core = JSON.parse(readFileSync(new URL("../../build.json", import.meta.url), "utf8"));
    const product = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    if (args[0] === "--core-info") console.log(JSON.stringify({ product: { name: "YunusPi", version: product.version }, core }, null, 2));
    else console.log(`YunusPi ${product.version} (core ${core.version}; origin Pi ${core.forkOrigin.version})`);
} else {
    setupCli();
    main(args).catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
