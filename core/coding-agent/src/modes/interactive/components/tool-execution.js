import { Box, Container, getCapabilities, Image, MouseRegion, sanitizeDisplayText, Spacer, Text, truncateToWidth, } from "@yunuspi/tui";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
const FALLBACK_PREVIEW_LINES = 3;
const ERROR_PREVIEW_LINES = 6;
/** Bound physical terminal rows, including a single very long JSON line. */
class ResultPreview extends Text {
    limit;
    constructor(text, limit, paddingX = 0, paddingY = 0, bgFn) {
        super(text, paddingX, paddingY, bgFn);
        this.limit = limit;
    }
    render(width) {
        const lines = super.render(width);
        if (lines.length <= this.limit) return lines;
        const hint = truncateToWidth(theme.fg("muted", `${lines.length - this.limit} more rows · `) + keyHint("app.tools.expand", "expand"), width, "…");
        return [...lines.slice(0, this.limit), this.customBgFn ? this.customBgFn(hint) : hint];
    }
}
export class ToolExecutionComponent extends Container {
    contentBox;
    contentText;
    contentTextRegion;
    selfRenderContainer;
    selfRenderHeight = 0;
    callRendererComponent;
    resultRendererComponent;
    rendererState = {};
    imageComponents = [];
    imageSpacers = [];
    toolName;
    toolCallId;
    args;
    expanded = false;
    showImages;
    imageWidthCells;
    isPartial = true;
    toolDefinition;
    ui;
    cwd;
    executionStarted = false;
    argsComplete = false;
    result;
    convertedImages = new Map();
    hideComponent = false;
    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {
        super();
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.args = args;
        this.toolDefinition = toolDefinition;
        this.showImages = options.showImages ?? true;
        this.imageWidthCells = options.imageWidthCells ?? 60;
        this.ui = ui;
        this.cwd = cwd;
        this.addChild(new Spacer(1));
        // Always create all shell variants. contentBox is used for default renderer-based composition.
        // selfRenderContainer is used when the tool renders its own framing.
        // contentText is reserved for generic fallback rendering when no tool definition exists.
        this.contentBox = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
        this.contentText = new ResultPreview("", Infinity, 1, 1, (text) => theme.bg("toolPendingBg", text));
        this.contentTextRegion = this.createResultRegion(this.contentText);
        this.selfRenderContainer = new Container();
        if (this.hasRendererDefinition()) {
            this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
        }
        else {
            this.addChild(this.contentTextRegion);
        }
        this.updateDisplay();
    }
    getCallRenderer() {
        return this.toolDefinition?.renderCall;
    }
    getResultRenderer() {
        return this.toolDefinition?.renderResult;
    }
    hasRendererDefinition() {
        return this.toolDefinition !== undefined;
    }
    getRenderShell() {
        return this.toolDefinition?.renderShell ?? "default";
    }
    getRenderContext(lastComponent) {
        return {
            args: this.args,
            toolCallId: this.toolCallId,
            invalidate: () => {
                this.invalidate();
                this.ui.requestRender();
            },
            lastComponent,
            state: this.rendererState,
            cwd: this.cwd,
            executionStarted: this.executionStarted,
            argsComplete: this.argsComplete,
            isPartial: this.isPartial,
            expanded: this.expanded,
            showImages: this.showImages,
            isError: this.result?.isError ?? false,
        };
    }
    createCallFallback() {
        return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
    }
    createResultFallback() {
        const output = this.getTextOutput();
        if (!output) {
            return undefined;
        }
        const text = output.split("\n").map(line => theme.fg("toolOutput", line)).join("\n");
        return new ResultPreview(text, this.expanded ? Infinity : this.result?.isError ? ERROR_PREVIEW_LINES : FALLBACK_PREVIEW_LINES);
    }
    createResultRegion(component) {
        return new MouseRegion(component, (event) => {
            if (!this.result || event.type !== "click" || event.button !== "left")
                return undefined;
            this.setExpanded(!this.expanded);
            return { handled: true };
        });
    }
    updateArgs(args) {
        this.args = args;
        this.updateDisplay();
    }
    markExecutionStarted() {
        this.executionStarted = true;
        this.updateDisplay();
        this.ui.requestRender();
    }
    setArgsComplete() {
        this.argsComplete = true;
        this.updateDisplay();
        this.ui.requestRender();
    }
    updateResult(result, isPartial = false) {
        this.result = result;
        this.isPartial = isPartial;
        this.updateDisplay();
        this.maybeConvertImagesForKitty();
    }
    maybeConvertImagesForKitty() {
        const caps = getCapabilities();
        if (caps.images !== "kitty")
            return;
        if (!this.result)
            return;
        const imageBlocks = this.result.content.filter((c) => c.type === "image");
        for (let i = 0; i < imageBlocks.length; i++) {
            const img = imageBlocks[i];
            if (!img.data || !img.mimeType)
                continue;
            if (img.mimeType === "image/png")
                continue;
            if (this.convertedImages.has(i))
                continue;
            const index = i;
            convertToPng(img.data, img.mimeType).then((converted) => {
                if (converted) {
                    this.convertedImages.set(index, converted);
                    this.updateDisplay();
                    this.ui.requestRender();
                }
            });
        }
    }
    setExpanded(expanded) {
        this.expanded = expanded;
        this.updateDisplay();
    }
    setShowImages(show) {
        this.showImages = show;
        this.updateDisplay();
    }
    setImageWidthCells(width) {
        this.imageWidthCells = Math.max(1, Math.floor(width));
        this.updateDisplay();
    }
    invalidate() {
        super.invalidate();
        this.updateDisplay();
    }
    render(width) {
        if (this.hideComponent) {
            return [];
        }
        if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
            const contentLines = this.selfRenderContainer.render(width);
            this.selfRenderHeight = contentLines.length;
            if (contentLines.length === 0 && this.imageComponents.length === 0) {
                return [];
            }
            const lines = [];
            if (contentLines.length > 0) {
                lines.push("");
                lines.push(...contentLines);
            }
            for (let i = 0; i < this.imageComponents.length; i++) {
                const spacer = this.imageSpacers[i];
                if (spacer) {
                    lines.push(...spacer.render(width));
                }
                const imageComponent = this.imageComponents[i];
                if (imageComponent) {
                    lines.push(...imageComponent.render(width));
                }
            }
            return lines;
        }
        return super.render(width);
    }
    handleMouse(event) {
        if (!this.hasRendererDefinition() || this.getRenderShell() !== "self")
            return super.handleMouse(event);
        if (event.y <= 0 || event.y > this.selfRenderHeight)
            return undefined;
        return this.selfRenderContainer.handleMouse({
            ...event,
            y: event.y - 1,
            height: this.selfRenderHeight,
        });
    }
    updateDisplay() {
        const bgFn = this.isPartial
            ? (text) => theme.bg("toolPendingBg", text)
            : this.result?.isError
                ? (text) => theme.bg("toolErrorBg", text)
                : (text) => theme.bg("toolSuccessBg", text);
        let hasContent = false;
        this.hideComponent = false;
        if (this.hasRendererDefinition()) {
            const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
            if (renderContainer instanceof Box) {
                renderContainer.setBgFn(bgFn);
            }
            renderContainer.clear();
            const callRenderer = this.getCallRenderer();
            if (!callRenderer) {
                renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
                hasContent = true;
            }
            else {
                try {
                    const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
                    this.callRendererComponent = component;
                    renderContainer.addChild(this.createResultRegion(component));
                    hasContent = true;
                }
                catch {
                    this.callRendererComponent = undefined;
                    renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
                    hasContent = true;
                }
            }
            if (this.result) {
                const resultRenderer = this.getResultRenderer();
                if (!resultRenderer) {
                    const component = this.createResultFallback();
                    if (component) {
                        renderContainer.addChild(this.createResultRegion(component));
                        hasContent = true;
                    }
                }
                else {
                    try {
                        const component = resultRenderer({ content: this.result.content, details: this.result.details }, { expanded: this.expanded, isPartial: this.isPartial }, theme, this.getRenderContext(this.resultRendererComponent));
                        this.resultRendererComponent = component;
                        renderContainer.addChild(this.createResultRegion(component));
                        hasContent = true;
                    }
                    catch {
                        this.resultRendererComponent = undefined;
                        const component = this.createResultFallback();
                        if (component) {
                            renderContainer.addChild(this.createResultRegion(component));
                            hasContent = true;
                        }
                    }
                }
            }
        }
        else {
            // Only text is collapsed. Native image components retain their
            // transport sequences and height below the preview.
            this.contentText.limit = this.expanded || !this.result ? Infinity : (this.result.isError ? ERROR_PREVIEW_LINES : FALLBACK_PREVIEW_LINES) + 3;
            this.contentText.setCustomBgFn(bgFn);
            this.contentText.setText(this.formatToolExecution());
            hasContent = true;
        }
        for (const img of this.imageComponents) {
            this.removeChild(img);
        }
        this.imageComponents = [];
        for (const spacer of this.imageSpacers) {
            this.removeChild(spacer);
        }
        this.imageSpacers = [];
        if (this.result) {
            const imageBlocks = this.result.content.filter((c) => c.type === "image");
            const caps = getCapabilities();
            for (let i = 0; i < imageBlocks.length; i++) {
                const img = imageBlocks[i];
                if (caps.images && this.showImages && img.data && img.mimeType) {
                    const converted = this.convertedImages.get(i);
                    const imageData = converted?.data ?? img.data;
                    const imageMimeType = converted?.mimeType ?? img.mimeType;
                    if (caps.images === "kitty" && imageMimeType !== "image/png")
                        continue;
                    const spacer = new Spacer(1);
                    this.addChild(spacer);
                    this.imageSpacers.push(spacer);
                    const imageComponent = new Image(imageData, imageMimeType, { fallbackColor: (s) => theme.fg("toolOutput", s) }, { maxWidthCells: this.imageWidthCells });
                    this.imageComponents.push(imageComponent);
                    this.addChild(imageComponent);
                }
            }
        }
        if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
            this.hideComponent = true;
        }
    }
    getTextOutput() {
        return getRenderedTextOutput(this.result, this.showImages);
    }
    formatToolExecution() {
        let text = theme.fg("toolTitle", theme.bold(this.toolName));
        const content = sanitizeDisplayText(JSON.stringify(this.args, null, this.expanded ? 2 : undefined));
        if (content) {
            text += this.expanded ? `\n\n${content}` : `\n${content.slice(0, 120)}${content.length > 120 ? "…" : ""}`;
        }
        const output = this.getTextOutput();
        if (output) {
            text += `\n${output}`;
        }
        return text;
    }
}
