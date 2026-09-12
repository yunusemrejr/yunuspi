(() => {
  "use strict";

  const root = document.getElementById("graphCanvas");
  const token = decodeURIComponent(window.location.hash.slice(1));
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  const palette = {
    project: "#9cc2ff",
    repository: "#67b8e8",
    branch: "#70d3b8",
    component: "#b9a4ff",
    feature: "#f2bc73",
    file: "#91a6c0",
    directory: "#70869e",
    api: "#e59ab8",
    database: "#8fd18a",
    table: "#8bbbe1",
    dependency: "#d2a0ee",
    configuration: "#d6ba80",
    pipeline: "#81cdd3",
    environment: "#a3c5a0",
    infrastructure: "#bd9dd6",
    decision: "#f09d79",
    change: "#efad6e",
    issue: "#ee8999",
    constraint: "#df9db3",
    session: "#a8b7d8",
    external: "#83b7ad",
    other: "#8995a8",
  };
  const state = {
    graph: null,
    cy: null,
    revision: 0,
    focusEpoch: 0,
    selectedId: "",
    focus: "",
    direction: "both",
    query: "",
    typeFilter: null,
    relationFilter: null,
    positions: {},
    storageKey: "",
    requestSerial: 0,
    pollTimer: 0,
    searchTimer: 0,
    connected: false,
    expandedType: "",
    clientId: `viewer-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
  };

  const $ = (id) => document.getElementById(id);
  const projectTitle = $("projectTitle");
  const projectContext = $("projectContext");
  const connectionDot = $("connectionDot");
  const connectionStatus = $("connectionStatus");
  const revisionLabel = $("revisionLabel");
  const statusMessage = $("statusMessage");
  const graphSummary = $("graphSummary");
  const visibleCount = $("visibleCount");
  const graphMode = $("graphMode");
  const graphEmpty = $("graphEmpty");
  const graphError = $("graphError");
  const graphErrorMessage = $("graphErrorMessage");
  const categoryFilters = $("categoryFilters");
  const relationFilters = $("relationFilters");
  const activityList = $("activityList");
  const activityCount = $("activityCount");
  const focusSelect = $("focusSelect");
  const inspectorTitle = $("inspectorTitle");
  const inspectorType = $("inspectorType");
  const inspectorContent = $("inspectorContent");

  function setText(element, value) {
    if (element) element.textContent = value == null ? "" : String(value);
  }

  function escapeNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function formatCount(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Math.max(0, Number(value) || 0));
  }

  function formatDate(value) {
    if (!value) return "recently";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 40);
    const delta = Math.max(0, Date.now() - date.getTime());
    if (delta < 60_000) return "just now";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function colorFor(type) {
    return palette[type] || palette.other;
  }

  function setConnection(kind, label) {
    state.connected = kind === "connected";
    connectionDot.className = `connection-dot ${kind === "connected" ? "connected" : kind === "error" ? "error" : ""}`;
    setText(connectionStatus, label);
  }

  function setStatus(message) {
    setText(statusMessage, message);
  }

  function readPositions() {
    if (!state.storageKey) return;
    try {
      const value = JSON.parse(window.localStorage.getItem(state.storageKey) || "{}");
      if (!value || typeof value !== "object") return;
      for (const [id, position] of Object.entries(value)) {
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) state.positions[id] = { x: position.x, y: position.y };
      }
    } catch { /* local storage is optional */ }
  }

  let savePositionsTimer = 0;
  function savePositions() {
    if (!state.storageKey || !state.cy) return;
    clearTimeout(savePositionsTimer);
    savePositionsTimer = window.setTimeout(() => {
      try {
        const value = {};
        state.cy.nodes().forEach((node) => {
          const position = node.position();
          if (Number.isFinite(position.x) && Number.isFinite(position.y)) value[node.id()] = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 };
        });
        window.localStorage.setItem(state.storageKey, JSON.stringify(value));
      } catch { /* local storage is optional */ }
    }, 180);
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function stablePosition(node, index) {
    const remembered = state.positions[node.id];
    if (remembered) return remembered;
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) return { x: node.x, y: node.y };
    if (node.type === "project") return { x: 0, y: 0 };
    const hash = hashString(node.id || `${node.type}-${index}`);
    const angle = ((hash % 360) * Math.PI) / 180;
    const ring = node.aggregate ? 650 : 150 + ((hash >>> 8) % 5) * 84;
    const typeBias = ((hash >>> 16) % 3 - 1) * 22;
    const position = { x: Math.cos(angle) * ring + typeBias, y: Math.sin(angle) * ring + typeBias };
    state.positions[node.id] = position;
    return position;
  }

  function apiHeaders() {
    return { Accept: "application/json", Authorization: `Bearer ${token}` };
  }

  async function fetchJson(pathname, options = {}) {
    if (!token) throw new Error("The viewer capability is missing from this URL");
    const response = await fetch(pathname, { ...options, headers: { ...apiHeaders(), ...(options.headers || {}) }, cache: "no-store" });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) throw new Error(payload.message || `Viewer request failed (${response.status})`);
    return payload;
  }

  function currentPath(endpoint = "/api/snapshot") {
    const params = new URLSearchParams();
    params.set("limit", "220");
    params.set("direction", state.direction);
    if (state.query) params.set("query", state.query);
    if (state.focus) params.set("focus", state.focus);
    if (state.typeFilter) params.set("types", state.typeFilter.size ? [...state.typeFilter].join(",") : "__none__");
    if (state.relationFilter) params.set("relations", state.relationFilter.size ? [...state.relationFilter].join(",") : "__none__");
    return `${endpoint}?${params.toString()}`;
  }

  function makeCyElements(graph) {
    const elements = [];
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const position = stablePosition(node, index);
      elements.push({
        group: "nodes",
        data: {
          id: node.id,
          label: node.label || node.id,
          type: node.type || "other",
          status: node.status || "",
          confidence: escapeNumber(node.confidence, 0),
          aggregate: node.aggregate === true,
          hiddenCount: escapeNumber(node.hiddenCount, 0),
          color: colorFor(node.type),
        },
        position,
      });
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      elements.push({
        group: "edges",
        data: {
          id: edge.id || `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          label: edge.type || "related",
          type: edge.type || "related",
          status: edge.status || "",
          confidence: escapeNumber(edge.confidence, 0),
          aggregate: edge.aggregate === true,
        },
      });
    }
    return elements;
  }

  function cyStyle() {
    return [
      { selector: "node", style: {
        "background-color": "data(color)",
        "border-color": "data(color)",
        "border-width": 1,
        "color": "#edf2fa",
        "font-family": "Inter, system-ui, sans-serif",
        "font-size": 10,
        "font-weight": 600,
        "label": "data(label)",
        "min-zoomed-font-size": 7,
        "padding": 4,
        "text-wrap": "ellipsis",
        "text-max-width": 112,
        "text-valign": "bottom",
        "text-margin-y": 8,
        "width": "mapData(confidence, 0, 1, 20, 34)",
        "height": "mapData(confidence, 0, 1, 20, 34)",
        "overlay-opacity": 0,
      } },
      { selector: "node[?aggregate]", style: {
        "shape": "round-rectangle",
        "background-opacity": .18,
        "border-style": "dashed",
        "border-width": 1.5,
        "font-size": 15,
        "min-zoomed-font-size": 12,
        "font-weight": 500,
        "text-valign": "center",
        "text-margin-y": 0,
        "width": 126,
        "height": 42,
        "text-max-width": 112,
      } },
      { selector: "node[type = 'project']", style: {
        "shape": "round-rectangle",
        "background-opacity": .35,
        "border-width": 2,
        "font-size": 15,
        "min-zoomed-font-size": 12,
        "font-weight": 700,
        "text-valign": "center",
        "text-margin-y": 0,
        "width": 142,
        "height": 52,
        "text-max-width": 126,
      } },
      { selector: "edge", style: {
        "curve-style": "bezier",
        "line-color": "#435065",
        "target-arrow-color": "#647b9f",
        "target-arrow-shape": "triangle",
        "arrow-scale": .65,
        "width": "mapData(confidence, 0, 1, .6, 2)",
        "opacity": .52,
        "line-style": "solid",
        "label": "",
        "overlay-opacity": 0,
      } },
      { selector: "edge[?aggregate]", style: { "line-style": "dashed", "line-color": "#64718a", "target-arrow-color": "#64718a", "opacity": .6 } },
      { selector: ".faded", style: { "opacity": .12 } },
      { selector: "edge.faded", style: { "opacity": .06 } },
      { selector: "node.compact-label", style: { "label": "", "text-opacity": 0 } },
      { selector: ".related", style: { "opacity": 1, "border-width": 2 } },
      { selector: "edge.related", style: { "line-color": "#9cc2ff", "target-arrow-color": "#9cc2ff", "width": 2.4, "opacity": .95 } },
      { selector: ".selected-entity", style: { "border-color": "#ffffff", "border-width": 3, "shadow-blur": 12, "shadow-color": "data(color)", "shadow-opacity": .55 } },
    ];
  }

  function applyHighlight() {
    if (!state.cy) return;
    state.cy.elements().removeClass("faded related selected-entity");
    if (!state.selectedId) return;
    const selected = state.cy.getElementById(state.selectedId);
    if (!selected || !selected.length) return;
    selected.addClass("selected-entity");
    const keepNodes = new Set([state.selectedId]);
    const keepEdges = [];
    state.cy.edges().forEach((edge) => {
      const source = edge.data("source");
      const target = edge.data("target");
      const incident = source === state.selectedId || target === state.selectedId;
      const directed = state.direction === "both" || (state.direction === "upstream" ? target === state.selectedId : source === state.selectedId);
      if (incident && directed) {
        keepEdges.push(edge);
        keepNodes.add(source);
        keepNodes.add(target);
      }
    });
    // An isolated project root is a valid graph state. Keep the overview
    // readable when selecting it instead of dimming every unrelated entity.
    if (!keepEdges.length) return;
    state.cy.nodes().forEach((node) => {
      if (keepNodes.has(node.id())) node.addClass("related"); else node.addClass("faded");
    });
    state.cy.edges().forEach((edge) => {
      if (keepEdges.includes(edge)) edge.addClass("related"); else edge.addClass("faded");
    });
  }

  function anchorScale(zoom) {
    // Project and aggregate nodes are the graph's landmarks. Keep their
    // labels at a readable screen size while the overview zooms out, without
    // changing any model positions or the user's layout.
    return Math.max(1, .8 / Math.max(.12, Number(zoom) || 1));
  }

  function updateAnchorStyles(zoom) {
    if (!state.cy) return;
    const scale = anchorScale(zoom);
    state.cy.nodes().forEach((node) => {
      const aggregate = node.data("aggregate") === true;
      const project = node.data("type") === "project";
      if (!aggregate && !project) return;
      const base = project
        ? { fontSize: 15, width: 142, height: 52, textMaxWidth: 126 }
        : { fontSize: 15, width: 126, height: 42, textMaxWidth: 112 };
      node.style({
        "font-size": base.fontSize * scale,
        "min-zoomed-font-size": 0,
        "width": base.width * scale,
        "height": base.height * scale,
        "text-max-width": base.textMaxWidth * scale,
        "text-opacity": 1,
      });
    });
  }

  function updateSemanticLabels() {
    if (!state.cy) return;
    const zoom = state.cy.zoom();
    state.cy.nodes().forEach((node) => {
      const keep = node.data("aggregate") || node.data("type") === "project" || zoom >= .62 || node.degree() >= 3;
      node.toggleClass("compact-label", !keep);
    });
    updateAnchorStyles(zoom);
  }

  function buildCategoryFilters(graph) {
    const counts = graph?.counts?.byType && typeof graph.counts.byType === "object" ? graph.counts.byType : {};
    const types = Object.entries(counts).filter(([, count]) => Number(count) > 0).sort(([a], [b]) => a.localeCompare(b));
    categoryFilters.replaceChildren();
    for (const [type, count] of types) {
      const label = document.createElement("label");
      label.className = "filter-item";
      label.style.setProperty("--type-color", colorFor(type));
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !state.typeFilter || state.typeFilter.has(type);
      checkbox.setAttribute("aria-label", `Show ${type} entities`);
      checkbox.addEventListener("change", () => {
        const selected = new Set([...categoryFilters.querySelectorAll("input[data-type]")].filter((input) => input.checked).map((input) => input.dataset.type));
        if (selected.size === types.length) state.typeFilter = null;
        else state.typeFilter = selected;
        loadGraph();
      });
      checkbox.dataset.type = type;
      const swatch = document.createElement("span");
      swatch.className = "filter-swatch";
      swatch.style.background = colorFor(type);
      swatch.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = type;
      const countLabel = document.createElement("span");
      countLabel.className = "filter-count";
      countLabel.textContent = formatCount(count);
      label.append(checkbox, swatch, text, countLabel);
      categoryFilters.append(label);
    }
  }

  function buildRelationFilters(graph) {
    const counts = new Map();
    for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
      const type = String(edge?.type || "related");
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    const relations = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
    relationFilters.replaceChildren();
    for (const [type, count] of relations) {
      const label = document.createElement("label");
      label.className = "filter-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !state.relationFilter || state.relationFilter.has(type);
      checkbox.setAttribute("aria-label", `Show ${type} relations`);
      checkbox.addEventListener("change", () => {
        const selected = new Set([...relationFilters.querySelectorAll("input[data-type]")].filter((input) => input.checked).map((input) => input.dataset.type));
        if (selected.size === relations.length) state.relationFilter = null;
        else state.relationFilter = selected;
        loadGraph();
      });
      checkbox.dataset.type = type;
      const swatch = document.createElement("span");
      swatch.className = "filter-swatch";
      swatch.style.background = "#647b9f";
      swatch.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = type;
      const countLabel = document.createElement("span");
      countLabel.className = "filter-count";
      countLabel.textContent = formatCount(count);
      label.append(checkbox, swatch, text, countLabel);
      relationFilters.append(label);
    }
  }

  function renderActivity(items) {
    const entries = Array.isArray(items) ? items.slice(0, 12) : [];
    activityList.replaceChildren();
    activityCount.textContent = String(entries.length);
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "muted small";
      empty.textContent = "No recent activity recorded.";
      activityList.append(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "activity-item";
      const label = entry?.label || entry?.kind || entry?.type || "Graph activity";
      item.append(document.createTextNode(String(label).slice(0, 180)));
      const time = document.createElement("time");
      time.dateTime = entry?.observedAt || entry?.updatedAt || entry?.createdAt || "";
      time.textContent = formatDate(time.dateTime);
      item.append(time);
      activityList.append(item);
    }
  }

  function updateSummary(graph) {
    const counts = graph?.counts || {};
    const totalNodes = Number(counts.totalNodes || graph?.nodes?.length || 0);
    const shownNodes = Number(counts.shownNodes || graph?.nodes?.filter((node) => !node.aggregate).length || 0);
    const totalEdges = Number(counts.totalEdges || graph?.edges?.length || 0);
    const aggregated = Array.isArray(counts.aggregated) ? counts.aggregated : [];
    setText(visibleCount, `${formatCount(shownNodes)} / ${formatCount(totalNodes)}`);
    setText(graphSummary, `${formatCount(shownNodes)} entities shown · ${formatCount(totalEdges)} relations${aggregated.length ? ` · ${aggregated.length} groups collapsed` : ""}`);
    setText(revisionLabel, `Revision ${graph?.revision ?? state.revision}`);
    setText(graphMode, state.query ? `Search: ${state.query.slice(0, 28)}` : state.expandedType ? `Expanded ${state.expandedType}` : "Live graph");
  }

  function updateFocusOptions(graph) {
    const current = state.focus;
    const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((node) => !node.aggregate).sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id))).slice(0, 300);
    focusSelect.replaceChildren();
    const whole = document.createElement("option");
    whole.value = "";
    whole.textContent = "Whole project";
    focusSelect.append(whole);
    for (const node of nodes) {
      const option = document.createElement("option");
      option.value = node.id;
      const fullLabel = String(node.label || node.id).replace(/\s+/g, " ");
      const displayLabel = fullLabel.length > 88 ? `${fullLabel.slice(0, 85)}…` : fullLabel;
      option.textContent = `${displayLabel} · ${node.type || "entity"}`;
      option.title = fullLabel;
      focusSelect.append(option);
    }
    focusSelect.value = nodes.some((node) => node.id === current) ? current : "";
  }

  function detailBlock(title) {
    const block = document.createElement("section");
    block.className = "detail-block";
    const heading = document.createElement("div");
    heading.className = "detail-heading";
    heading.textContent = title;
    block.append(heading);
    return block;
  }

  function detailRow(parent, key, value) {
    const keyElement = document.createElement("span");
    keyElement.className = "detail-key";
    keyElement.textContent = key;
    const valueElement = document.createElement("span");
    valueElement.className = "detail-value";
    valueElement.textContent = value == null || value === "" ? "—" : String(value);
    parent.append(keyElement, valueElement);
  }

  function renderInspector(node, details = null) {
    inspectorContent.replaceChildren();
    if (!node) {
      setText(inspectorTitle, "Nothing selected");
      setText(inspectorType, "Select a node in the graph");
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Choose a node to see its provenance, confidence, and nearby relations.";
      inspectorContent.append(empty);
      return;
    }
    setText(inspectorTitle, node.label || node.id);
    setText(inspectorType, node.aggregate ? `${node.type} group` : node.type || "entity");

    const summary = detailBlock("Current status");
    const summaryGrid = document.createElement("div");
    summaryGrid.className = "detail-grid";
    detailRow(summaryGrid, "Status", node.status || "unknown");
    detailRow(summaryGrid, "Confidence", typeof node.confidence === "number" ? `${Math.round(node.confidence * 100)}%` : "unknown");
    detailRow(summaryGrid, "Identifier", node.id);
    if (typeof node.confidence === "number") {
      const bar = document.createElement("div");
      bar.className = "confidence-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round(node.confidence * 100)}%`;
      bar.append(fill);
      summaryGrid.append(bar);
    }
    summary.append(summaryGrid);
    inspectorContent.append(summary);

    if (node.aggregate) {
      const aggregate = detailBlock("Collapsed group");
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = `${formatCount(node.hiddenCount)} ${node.type || "other"} entities are outside the current view.`;
      aggregate.append(copy);
      const button = document.createElement("button");
      button.className = "quiet expand-button";
      button.type = "button";
      button.textContent = `Expand ${node.type || "group"}`;
      button.addEventListener("click", () => {
        state.expandedType = node.type || "";
        // Keep the project anchor in view while expanding a collapsed
        // category; it remains the orientation point for the expanded slice.
        state.typeFilter = new Set([node.type, "project"]);
        loadGraph();
      });
      aggregate.append(button);
      inspectorContent.append(aggregate);
      return;
    }

    if (!details) {
      const loading = document.createElement("p");
      loading.className = "muted small";
      loading.textContent = "Loading provenance and relations…";
      inspectorContent.append(loading);
      return;
    }
    const provenance = detailBlock("Provenance");
    const entries = Array.isArray(details.provenance) ? details.provenance : [];
    if (!entries.length) {
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = "No source evidence attached.";
      provenance.append(copy);
    } else {
      const list = document.createElement("div");
      list.className = "provenance";
      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "provenance-entry";
        const kind = document.createElement("strong");
        kind.textContent = entry.kind || "source";
        const locator = document.createElement("span");
        locator.textContent = entry.locator || "No locator";
        const meta = document.createElement("span");
        meta.textContent = `${entry.scope || "shared"} · v${entry.version ?? "—"} · ${formatDate(entry.observedAt)}`;
        item.append(kind, locator, meta);
        list.append(item);
      }
      provenance.append(list);
    }
    inspectorContent.append(provenance);

    const edges = detailBlock("Nearby relations");
    const relationEntries = Array.isArray(details.edges) ? details.edges.slice(0, 16) : [];
    if (!relationEntries.length) {
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = "No direct relations in the current scope.";
      edges.append(copy);
    } else {
      const list = document.createElement("div");
      list.className = "relation-list";
      for (const edge of relationEntries) {
        const item = document.createElement("div");
        item.className = "relation";
        const kind = document.createElement("span");
        kind.className = "relation-kind";
        kind.textContent = edge.type || "related";
        const target = document.createElement("span");
        target.textContent = edge.source === node.id ? `→ ${edge.target}` : `← ${edge.source}`;
        item.append(kind, target);
        list.append(item);
      }
      edges.append(list);
    }
    inspectorContent.append(edges);

    const facts = detailBlock("Literal facts");
    const factEntries = Array.isArray(details.facts) ? details.facts.slice(0, 12) : [];
    if (!factEntries.length) {
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = "No literal claims attached.";
      facts.append(copy);
    } else {
      const grid = document.createElement("div");
      grid.className = "detail-grid";
      for (const fact of factEntries) detailRow(grid, fact.predicate || "fact", fact.object);
      facts.append(grid);
    }
    inspectorContent.append(facts);

    const historyEntries = Array.isArray(details.history) ? details.history.slice(0, 8) : [];
    if (historyEntries.length) {
      const history = detailBlock("Recent changes");
      const list = document.createElement("div");
      list.className = "relation-list";
      for (const entry of historyEntries) {
        const item = document.createElement("div");
        item.className = "relation";
        const kind = document.createElement("span");
        kind.className = "relation-kind";
        kind.textContent = entry.event || entry.kind || "change";
        const label = document.createElement("span");
        label.textContent = entry.sourceId ? `${entry.sourceId} · ${formatDate(entry.createdAt || entry.observedAt)}` : formatDate(entry.createdAt || entry.observedAt);
        item.append(kind, label);
        list.append(item);
      }
      history.append(list);
      inspectorContent.append(history);
    }
  }

  async function selectNode(nodeId, options = {}) {
    state.selectedId = nodeId || "";
    const node = state.graph?.nodes?.find((entry) => entry.id === state.selectedId) || null;
    renderInspector(node);
    applyHighlight();
    if (!node || node.aggregate || options.loadDetails === false) return;
    try {
      const details = await fetchJson(`/api/node?id=${encodeURIComponent(node.id)}`);
      if (state.selectedId === node.id) renderInspector(node, details.node ? { ...details.node, edges: details.edges, facts: details.facts, history: details.history, health: details.health } : details);
    } catch (error) {
      if (state.selectedId !== node.id) return;
      const message = document.createElement("p");
      message.className = "muted small";
      message.textContent = `Provenance unavailable: ${error.message}`;
      inspectorContent.append(message);
    }
  }

  function fitGraph() {
    if (!state.cy || !state.cy.nodes().length) return;
    state.cy.fit(state.cy.elements(), 50);
    // Cytoscape emits zoom for most fit calls, but applying this explicitly
    // also covers a fit that keeps the same zoom level.
    updateSemanticLabels();
  }

  function keyboardNavigate(event) {
    if (!state.cy || !state.cy.nodes().length) return;
    const key = event.key;
    if (["+", "=", "-", "0", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"].includes(key)) event.preventDefault();
    if (key === "+" || key === "=") { state.cy.zoom({ level: Math.min(3, state.cy.zoom() * 1.2), renderedPosition: { x: state.cy.width() / 2, y: state.cy.height() / 2 } }); return; }
    if (key === "-") { state.cy.zoom({ level: Math.max(.15, state.cy.zoom() / 1.2), renderedPosition: { x: state.cy.width() / 2, y: state.cy.height() / 2 } }); return; }
    if (key === "0") { fitGraph(); return; }
    if (key === "Escape") { void selectNode(""); return; }
    if (key === "Enter" && state.selectedId) { void selectNode(state.selectedId); return; }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
    const nodes = state.cy.nodes().filter((node) => !node.data("aggregate"));
    if (!nodes.length) return;
    const current = state.selectedId ? state.cy.getElementById(state.selectedId) : null;
    if (!current || !current.length) { void selectNode(nodes[0].id()); return; }
    const currentPosition = current.position();
    const vector = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } }[key];
    let candidate = null;
    let bestScore = Number.POSITIVE_INFINITY;
    nodes.forEach((node) => {
      if (node.id() === current.id()) return;
      const position = node.position();
      const dx = position.x - currentPosition.x;
      const dy = position.y - currentPosition.y;
      const dot = dx * vector.x + dy * vector.y;
      if (dot <= 0) return;
      const distance = Math.hypot(dx, dy);
      const lateral = Math.abs(dx * vector.y - dy * vector.x);
      const score = distance + lateral * .5;
      if (score < bestScore) { bestScore = score; candidate = node; }
    });
    if (!candidate) {
      candidate = nodes.sort((a, b) => a.id().localeCompare(b.id())).find((node) => node.id() !== current.id()) || current;
    }
    void selectNode(candidate.id());
    state.cy.animate({ center: { eles: candidate }, duration: reducedMotion ? 0 : 180 });
  }

  function setupCy() {
    if (typeof window.cytoscape !== "function") throw new Error("The local graph renderer did not load");
    state.cy = window.cytoscape({
      container: root,
      elements: [],
      style: cyStyle(),
      layout: { name: "preset", fit: false },
      minZoom: .12,
      maxZoom: 4,
      wheelSensitivity: .18,
      boxSelectionEnabled: false,
      autoungrabify: false,
      autounselectify: true,
    });
    state.cy.on("tap", "node", (event) => void selectNode(event.target.id()));
    state.cy.on("dragfree", "node", savePositions);
    state.cy.on("mouseover", "node", (event) => { root.setAttribute("aria-label", `${event.target.data("label")}, ${event.target.data("type")}. Press Enter to inspect.`); });
    state.cy.on("mouseout", "node", () => root.setAttribute("aria-label", "Interactive project intelligence graph. Use arrow keys to move between nodes."));
    state.cy.on("zoom", updateSemanticLabels);
    root.addEventListener("keydown", keyboardNavigate);
    // Keep the position readout private to the page. It is useful to verify
    // that a revision refresh preserves the user's mental map in browser QA,
    // while all product interaction remains through the graph itself.
    Object.defineProperty(window, "__projectIntelligenceViewer", {
      configurable: true,
      value: {
        positions: () => {
          const positions = {};
          state.cy.nodes().forEach((node) => {
            const position = node.position();
            positions[node.id()] = { x: position.x, y: position.y };
          });
          return positions;
        },
        anchors: () => {
          const zoom = state.cy.zoom();
          return state.cy.nodes().filter((node) => node.data("aggregate") === true || node.data("type") === "project").map((node) => {
            const fontSize = Number(node.pstyle("font-size")?.pfValue || 0);
            return {
              id: node.id(),
              label: String(node.data("label") || ""),
              compact: node.hasClass("compact-label"),
              textOpacity: Number(node.pstyle("text-opacity")?.pfValue ?? 1),
              minZoomedFontSize: Number(node.pstyle("min-zoomed-font-size")?.pfValue || 0),
              renderedFontSize: fontSize * zoom,
            };
          });
        },
        state: () => ({ revision: state.revision, focusEpoch: state.focusEpoch, selectedId: state.selectedId }),
      },
    });
  }

  function renderGraph(graph) {
    state.graph = graph || { nodes: [], edges: [], counts: {} };
    state.revision = Number(graph?.revision || state.revision || 0);
    if (Number.isFinite(graph?.focusEpoch)) state.focusEpoch = Number(graph.focusEpoch);
    updateSummary(state.graph);
    buildCategoryFilters(state.graph);
    buildRelationFilters(state.graph);
    updateFocusOptions(state.graph);
    renderActivity(state.graph.activity);
    graphEmpty.hidden = Boolean(state.graph.nodes?.length);
    graphError.hidden = true;
    if (!state.cy) setupCy();
    state.cy.elements().remove();
    const elements = makeCyElements(state.graph);
    if (elements.length) state.cy.add(elements);
    state.cy.nodes().forEach((node) => {
      const remembered = stablePosition(node.data(), 0);
      node.position(remembered);
    });
    updateSemanticLabels();
    if (!state.selectedId || !state.graph.nodes.some((node) => node.id === state.selectedId)) {
      state.selectedId = "";
      renderInspector(null);
    }
    applyHighlight();
    if (!state.cy.nodes().length) return;
    if (!state.hasFitted) { fitGraph(); state.hasFitted = true; }
    savePositions();
    setStatus(`Live at revision ${state.revision}.`);
  }

  async function loadGraph() {
    const serial = ++state.requestSerial;
    setStatus("Reading the latest project graph…");
    try {
      const graph = await fetchJson(currentPath());
      if (serial !== state.requestSerial) return;
      renderGraph(graph);
      setConnection("connected", "Connected");
    } catch (error) {
      if (serial !== state.requestSerial) return;
      setConnection("error", "Disconnected");
      graphError.hidden = false;
      graphErrorMessage.textContent = error.message;
      setStatus("Viewer could not read the project. Retry when the local server is available.");
    }
  }

  async function pollGraph() {
    try {
      const reply = await fetchJson(currentPath("/api/poll") + `&since=${encodeURIComponent(state.revision)}`);
      if (Number.isFinite(reply.focusEpoch)) {
        const nextFocusEpoch = Number(reply.focusEpoch);
        if (nextFocusEpoch > state.focusEpoch) {
          state.focusEpoch = nextFocusEpoch;
          try { window.focus(); } catch { /* browser may reject focus from a background tab */ }
        } else state.focusEpoch = nextFocusEpoch;
      }
      if (Array.isArray(reply.activity)) renderActivity(reply.activity);
      if (reply.changed) {
        renderGraph(reply);
        setConnection("connected", "Updated");
      } else if (state.connected) {
        setConnection("connected", "Live");
      }
    } catch (error) {
      setConnection("error", "Reconnecting");
      setStatus(error.message);
    }
  }

  async function heartbeat(visible = document.visibilityState !== "hidden", closed = false) {
    try {
      await fetchJson("/api/heartbeat", { method: "POST", keepalive: closed, headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: state.clientId, visible, closed }) });
    } catch { /* lifecycle recovery is handled by polling */ }
  }

  function schedulePolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(() => { void pollGraph(); }, 2500);
  }

  function wireControls() {
    $("searchInput").addEventListener("input", (event) => {
      state.query = String(event.target.value || "").trim().slice(0, 120);
      clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => void loadGraph(), 240);
    });
    $("directionSelect").addEventListener("change", (event) => { state.direction = event.target.value; if (state.focus) void loadGraph(); else applyHighlight(); });
    focusSelect.addEventListener("change", (event) => {
      state.focus = String(event.target.value || "");
      state.selectedId = state.focus;
      void loadGraph().then(() => { if (state.focus) void selectNode(state.focus); });
    });
    $("focusButton").addEventListener("click", () => { if (state.selectedId) { state.focus = state.selectedId; focusSelect.value = state.focus; void loadGraph(); } });
    $("fitButton").addEventListener("click", fitGraph);
    $("resetButton").addEventListener("click", () => { state.focus = ""; state.direction = "both"; state.query = ""; state.typeFilter = null; state.relationFilter = null; state.expandedType = ""; $("searchInput").value = ""; $("directionSelect").value = "both"; void loadGraph(); });
    $("clearFiltersButton").addEventListener("click", () => { state.typeFilter = null; state.expandedType = ""; void loadGraph(); });
    $("clearRelationFiltersButton").addEventListener("click", () => { state.relationFilter = null; void loadGraph(); });
    $("showAllButton").addEventListener("click", () => { state.typeFilter = null; state.relationFilter = null; state.expandedType = ""; void loadGraph(); });
    $("retryButton").addEventListener("click", loadGraph);
    document.addEventListener("visibilitychange", () => { void heartbeat(document.visibilityState !== "hidden"); });
    let closing = false;
    const markClosed = () => {
      if (closing) return;
      closing = true;
      void heartbeat(false, true);
    };
    window.addEventListener("pagehide", markClosed);
    window.addEventListener("beforeunload", markClosed);
    window.addEventListener("pageshow", () => { closing = false; void heartbeat(true); });
  }

  async function start() {
    setConnection("connecting", "Connecting");
    if (!token) {
      setConnection("error", "Invalid link");
      graphError.hidden = false;
      graphErrorMessage.textContent = "This viewer link has no capability fragment. Reopen it from the /graph command.";
      setStatus("Viewer link is missing its private capability.");
      return;
    }
    wireControls();
    try {
      const bootstrap = await fetchJson(currentPath("/api/bootstrap"));
      const project = bootstrap.project || {};
      state.storageKey = `project-intelligence:${project.id || location.origin}`;
      readPositions();
      setText(projectTitle, project.name || "Project intelligence");
      setText(projectContext, [project.branch && `branch ${project.branch}`, project.checkoutId && `checkout ${project.checkoutId}`].filter(Boolean).join(" · ") || "Local project graph");
      setText($("serverVersion"), bootstrap.serverVersion || "Local read-only session");
      renderGraph(bootstrap);
      setConnection("connected", "Connected");
      await heartbeat(true);
      schedulePolling();
      window.setInterval(() => { void heartbeat(document.visibilityState !== "hidden"); }, 15_000);
    } catch (error) {
      setConnection("error", "Disconnected");
      graphError.hidden = false;
      graphErrorMessage.textContent = error.message;
      setStatus("Viewer could not start. Retry when the local server is available.");
    }
  }

  void start();
})();
