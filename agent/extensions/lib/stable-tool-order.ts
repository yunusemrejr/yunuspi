/** Stabilize unordered tool inventories without touching schemas or messages. */
export function stableToolOrder(payload: any): any {
  if (process.env.PI_STABLE_TOOL_ORDER === "off" || !payload || !Array.isArray(payload.tools)) return payload;
  const tools = payload.tools;
  if (tools.length < 2 || tools.length > 512) return payload;
  const names: string[] = [];
  for (const tool of tools) {
    // Positional cache breakpoints, provider built-ins and unknown shapes must
    // retain their original order. The explicit schema's property order stays intact.
    if (!tool || typeof tool !== "object" || "cache_control" in tool) return payload;
    if (tool.function !== undefined && (!tool.function || typeof tool.function !== "object")) return payload;
    const name = tool.type === "function" ? tool.function?.name ?? tool.name :
      tool.type === undefined && tool.input_schema ? tool.name : undefined;
    if (typeof name !== "string" || !name || tool.function && "cache_control" in tool.function) return payload;
    names.push(name);
  }
  if (new Set(names).size !== names.length) return payload;
  const indices = names.map((_, i) => i).sort((a,b) => names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0);
  return indices.every((n,i) => n === i) ? payload : { ...payload, tools: indices.map(i => tools[i]) };
}
