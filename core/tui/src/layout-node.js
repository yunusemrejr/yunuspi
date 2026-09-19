export const LAYOUT_NODE = Symbol.for("@yunuspi/tui/layout-node");
export function getLayoutNode(component) {
    const candidate = component;
    return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}
