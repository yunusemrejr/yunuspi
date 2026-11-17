/**
 * Process @file CLI arguments into text content and image attachments
 */
import { withRegularReadFile } from "@yunuspi/agent-core/node";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.js";
import { processImage } from "../utils/image-process.js";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../utils/mime.js";
import { stripBom } from "../utils/text.js";
/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs, options) {
    const autoResizeImages = options?.autoResizeImages ?? true;
    let text = "";
    const images = [];
    for (const fileArg of fileArgs) {
        // Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
        const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));
        let content;
        try {
            content = await withRegularReadFile(absolutePath, undefined, file => file.readFile());
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = error?.code === "ENOENT" || error?.code === "ENOTDIR"
                ? `File not found: ${absolutePath}`
                : `Could not read file ${absolutePath}: ${reason}`;
            console.error(chalk.red(`Error: ${message}`));
            process.exit(1);
        }
        if (content.length === 0) {
            continue;
        }
        const mimeType = detectSupportedImageMimeType(content.subarray(0, IMAGE_TYPE_SNIFF_BYTES));
        if (mimeType) {
            // Handle image file
            const processed = await processImage(content, mimeType, { autoResizeImages });
            if (!processed.ok) {
                text += `<file name="${absolutePath}">${processed.message}</file>\n`;
                continue;
            }
            const attachment = {
                type: "image",
                mimeType: processed.mimeType,
                data: processed.data,
            };
            images.push(attachment);
            // Add text reference to image with optional processing hints
            if (processed.hints.length > 0) {
                text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
            }
            else {
                text += `<file name="${absolutePath}"></file>\n`;
            }
        }
        else {
            text += `<file name="${absolutePath}">\n${stripBom(content.toString("utf-8"))}\n</file>\n`;
        }
    }
    return { text, images };
}
