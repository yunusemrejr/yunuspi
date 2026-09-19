/* PI_THINKING_DISPLAY_V4 */
function normalizeThinkingStream(raw){if(/(^|\n)(?:\s*```|\s*~~~|\s*(?:[-*+]|\d+\.)\s| {4}\S|\t\S)/.test(raw))return raw;if(!raw.includes("\n"))return raw;let lines=raw.split("\n").filter(l=>l.length>0);if(lines.length<4)return raw;let single=0,spaceLead=0,spaceOnly=0,total=0;for(let line of lines){let trimmed=line.trim();if(!trimmed){spaceOnly++;continue}if(!trimmed.includes(" "))single++;if(/^ /.test(line))spaceLead++;total+=trimmed.length}let nonEmpty=lines.length-spaceOnly;if(spaceOnly*4>=lines.length){if(!nonEmpty)return"";if(single/nonEmpty>=.35&&total/nonEmpty<=20)return lines.filter(l=>l.trim().length>0).join(spaceLead/nonEmpty>=.25?"":" ")}if(nonEmpty<4||single/nonEmpty<.35||total/nonEmpty>20)return raw;let nlCount=0,totalRuns=0,heavyRuns=0;for(let idx=0;idx<raw.length;idx++){if(raw[idx]==="\n"){nlCount++;continue}if(nlCount>0){totalRuns++;if(nlCount>=3)heavyRuns++;nlCount=0}}if(nlCount>0){totalRuns++;if(nlCount>=3)heavyRuns++}if(spaceLead/lines.length<.25&&heavyRuns/totalRuns<.1)return raw;let sep=spaceLead/nonEmpty>=.25?"":" ";let out="",nlRun=0;for(let idx=0;idx<raw.length;idx++){if(raw[idx]==="\n"){nlRun++;continue}if(nlRun>0){if(sep&&out&&raw[idx]!==" ")out+=sep;nlRun=0}out+=raw[idx]}return out}
import { Container, Markdown, MouseRegion, Spacer, Text } from "@yunuspi/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { createMarkdownTransform } from "./markdown-transform.js";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
    contentContainer;
    hideThinkingBlock;
    markdownTheme;
    hiddenThinkingLabel;
    outputPad;
    markdownTransformers;
    lastMessage;
    hasToolCalls = false;
    isStreaming = false;
    thinkingVisibilityOverrides = new Map();
    constructor(message, hideThinkingBlock = false, markdownTheme = getMarkdownTheme(), hiddenThinkingLabel = "Thinking...", outputPad = 1, markdownTransformers = []) {
        super();
        this.hideThinkingBlock = hideThinkingBlock;
        this.markdownTheme = markdownTheme;
        this.hiddenThinkingLabel = hiddenThinkingLabel;
        this.outputPad = outputPad;
        this.markdownTransformers = markdownTransformers;
        // Container for text/thinking content
        this.contentContainer = new Container();
        this.addChild(this.contentContainer);
        if (message) {
            this.updateContent(message);
        }
    }
    invalidate() {
        super.invalidate();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHideThinkingBlock(hide) {
        this.hideThinkingBlock = hide;
        this.thinkingVisibilityOverrides.clear();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHiddenThinkingLabel(label) {
        this.hiddenThinkingLabel = label;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setOutputPad(padding) {
        this.outputPad = padding;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    render(width) {
        const lines = super.render(width);
        if (this.hasToolCalls || lines.length === 0) {
            return lines;
        }
        lines[0] = OSC133_ZONE_START + lines[0];
        lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
        return lines;
    }
    updateContent(message, isStreaming = this.isStreaming) {
        this.lastMessage = message;
        this.isStreaming = isStreaming;
        // Clear content container
        this.contentContainer.clear();
        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
        if (hasVisibleContent) {
            this.contentContainer.addChild(new Spacer(1));
        }
        // Render content in order
        let thinkingRunIndex = 0;
        for (let i = 0; i < message.content.length; i++) {
            const content = message.content[i];
            if (content.type === "text" && content.text.trim()) {
                // Assistant text messages with no background - trim the text
                // Set paddingY=0 to avoid extra spacing before tool executions
                this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
                    transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
                }));
            }
            else if (content.type === "thinking") {
                const thinkingBlocks = [];
                for (; i < message.content.length; i++) {
                    const thinkingContent = message.content[i];
                    if (thinkingContent.type !== "thinking") {
                        break;
                    }
                    const thinking = normalizeThinkingStream(thinkingContent.thinking).trim();
                    if (thinking) {
                        thinkingBlocks.push(thinking);
                    }
                }
                i--;
                if (thinkingBlocks.length === 0) {
                    continue;
                }
                // Add spacing only when another visible assistant content block follows.
                // This avoids a superfluous blank line before separately-rendered tool execution blocks.
                const hasVisibleContentAfter = message.content
                    .slice(i + 1)
                    .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
                const runIndex = thinkingRunIndex++;
                const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
                const thinkingComponent = hidden
                    ? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
                    : new Markdown(thinkingBlocks.join("\n\n"), this.outputPad, 0, this.markdownTheme, {
                        color: (text) => theme.fg("thinkingText", text),
                        italic: true,
                    }, {
                        transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
                    });
                this.contentContainer.addChild(new MouseRegion(thinkingComponent, (event) => {
                    if (event.type !== "click" || event.button !== "left")
                        return undefined;
                    this.thinkingVisibilityOverrides.set(runIndex, !hidden);
                    if (this.lastMessage)
                        this.updateContent(this.lastMessage);
                    return { handled: true };
                }));
                if (hasVisibleContentAfter) {
                    this.contentContainer.addChild(new Spacer(1));
                }
            }
        }
        // Check if incomplete/failed - show after partial content.
        // For aborted/error tool calls, tool execution components show the error.
        // Length stops can happen before a tool call is complete, so surface them here too.
        const hasToolCalls = message.content.some((c) => c.type === "toolCall");
        this.hasToolCalls = hasToolCalls;
        if (message.stopReason === "length") {
            this.contentContainer.addChild(new Spacer(1));
            this.contentContainer.addChild(new Text(theme.fg("error", (/* PI_TRUNCATION_CONTEXT */ message.errorMessage || "Response was truncated before completion — " + message.provider + "/" + message.model + "; observed request maxTokens unavailable.")), this.outputPad, 0));
        }
        else if (!hasToolCalls) {
            if (message.stopReason === "aborted") {
                const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"
                    ? message.errorMessage
                    : "Operation aborted";
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
            }
            else if (message.stopReason === "error") {
                const errorMsg = message.errorMessage || "Unknown error";
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
            }
        }
    }
}
