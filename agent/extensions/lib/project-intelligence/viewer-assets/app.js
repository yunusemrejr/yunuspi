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
    hops: 1,
    offset: 0,
    includeInactive: false,
    navigation: [],
    listView: false,
    detailSerial: 0,
    loading: false,
    polling: false,
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
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) { state.positions[id] = { x: position.x, y: position.y }; state.restoredPositions = true; }
      }
    } catch { /* local storage is optional */ }
  }

  let savePositionsTimer = 0;
  function savePositions() {
    if (!state.storageKey || !state.cy) return;
    clearTimeout(savePositionsTimer);
    savePositionsTimer = window.setTimeout(() => {
      try {
        const value = Object.fromEntries(Object.entries(state.positions).slice(-2000));
        state.cy.nodes().forEach((node) => {
          const position = node.position();
          if (Number.isFinite(position.x) && Number.isFinite(position.y)) value[node.id()] = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 };
        });
        window.localStorage.setItem(state.storageKey, JSON.stringify(value));
        window.localStorage.setItem(`${state.storageKey}:view`, JSON.stringify({ focus: state.focus, query: state.query, direction: state.direction, hops: state.hops,
          types: state.typeFilter ? [...state.typeFilter] : null, relations: state.relationFilter ? [...state.relationFilter] : null,
          includeInactive: state.includeInactive, layout: $("layoutSelect").value, listView: state.listView }));
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
    params.set("hops", String(state.hops));
    params.set("offset", String(state.offset));
    if (state.includeInactive) params.set("includeInactive", "1");
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
          label: node.aggregate ? `${formatCount(node.hiddenCount)} ${node.type}` : node.label || node.id,
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
        "background-opacity": .14,
        "shape": "round-rectangle",
        "border-color": "data(color)",
        "border-width": 1,
        "color": "#edf2fa",
        "font-family": "Inter, system-ui, sans-serif",
        "font-size": 12,
        "font-weight": 600,
        "label": "data(label)",
        "min-zoomed-font-size": 0,
        "padding": 4,
        "text-wrap": "ellipsis",
        "text-max-width": 140,
        "text-valign": "center",
        "text-margin-y": 0,
        "width": 140,
        "height": 36,
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
      { selector: "edge[status = 'inferred'], edge[status = 'assumed']", style: { "line-style": "dashed" } },
      { selector: "edge[?aggregate]", style: { "line-style": "dashed", "line-color": "#64718a", "target-arrow-color": "#64718a", "opacity": .6 } },
      { selector: ".faded", style: { "opacity": .12 } },
      { selector: "edge.faded", style: { "opacity": .06 } },
      { selector: "node.compact-label", style: { "label": "", "text-opacity": 0 } },
      { selector: ".related", style: { "opacity": 1, "border-width": 2 } },
      { selector: "edge.related", style: { "line-color": "#9cc2ff", "target-arrow-color": "#9cc2ff", "width": 2.4, "opacity": .95, "label": "data(label)", "font-size": 10, "color": "#cbdcf5", "text-background-color": "#0d1117", "text-background-opacity": .9, "text-background-padding": 3, "text-rotation": "autorotate" } },
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
      const directed = state.direction === "both" || (state.direction === "incoming" ? target === state.selectedId : source === state.selectedId);
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
      node.removeClass("compact-label");
    });
    updateAnchorStyles(zoom);
  }

  function buildCategoryFilters(graph) {
    const counts = graph?.counts?.byType && typeof graph.counts.byType === "object" ? graph.counts.byType : {};
    const types = Object.entries(counts).filter(([, count]) => Number(count) > 0).sort(([a], [b]) => a.localeCompare(b));
    const signature = JSON.stringify([types, state.typeFilter && [...state.typeFilter]]);
    if (categoryFilters.dataset.signature === signature) return;
    categoryFilters.dataset.signature = signature;
    const focusedType = categoryFilters.contains(document.activeElement) ? document.activeElement.dataset.type : null;
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
        state.offset = 0;
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
      if (focusedType === type) checkbox.focus({ preventScroll: true });
    }
  }

  function buildRelationFilters(graph) {
    const relations = Object.entries(graph?.counts?.byRelation || {}).sort(([a], [b]) => a.localeCompare(b));
    const signature = JSON.stringify([relations, state.relationFilter && [...state.relationFilter]]);
    if (relationFilters.dataset.signature === signature) return;
    relationFilters.dataset.signature = signature;
    const focusedType = relationFilters.contains(document.activeElement) ? document.activeElement.dataset.type : null;
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
        state.offset = 0;
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
      if (focusedType === type) checkbox.focus({ preventScroll: true });
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
      time.textContent = time.dateTime ? formatDate(time.dateTime) : `${typeof entry.state === "string" ? entry.state : "active"}${entry.files?.length ? ` · ${entry.files.length} files` : ""}`;
      item.append(time);
      activityList.append(item);
    }
  }

  function updateSummary(graph) {
    const counts = graph?.counts || {};
    const totalNodes = Number(counts.totalNodes ?? graph?.nodes?.length ?? 0);
    const shownNodes = Number(counts.shownNodes ?? graph?.nodes?.filter((node) => !node.aggregate).length ?? 0);
    const totalEdges = Number(counts.totalEdges ?? graph?.edges?.length ?? 0);
    const aggregated = Array.isArray(counts.aggregated) ? counts.aggregated : [];
    setText(visibleCount, `${formatCount(shownNodes)} / ${formatCount(totalNodes)}`);
    setText(graphSummary, `${formatCount(shownNodes)} entities · ${formatCount(graph?.edges?.length ?? 0)} / ${formatCount(totalEdges)} relations${aggregated.length ? ` · ${aggregated.length} groups collapsed` : ""}`);
    setText(revisionLabel, `Revision ${graph?.revision ?? state.revision}`);
    setText(graphMode, state.query ? `Search: ${state.query.slice(0, 28)}` : state.expandedType ? `Expanded ${state.expandedType}` : state.focus ? "Focused neighborhood" : "Project overview");
  }

  function updateNavigation(graph) {
    const page = graph.page || {};
    $("previousPage").disabled = !state.offset;
    $("nextPage").disabled = !page.hasMore || Boolean(state.focus);
    $("pageLabel").textContent = page.hasMore || state.offset ? `${state.offset + 1}–${state.offset + graph.nodes.filter(node => !node.aggregate).length} of ${page.total}` : "";
    $("backButton").disabled = !state.navigation.length;
    const focus = graph.nodes.find(node => node.id === state.focus);
    setText($("viewContext"), focus ? `${focus.label} · ${state.hops} hop${state.hops === 1 ? "" : "s"}` : state.query ? `Results for “${state.query}”` : state.typeFilter ? [...state.typeFilter].join(", ") : "Whole project");
    const health = graph.health || {}, discovery = graph.discovery;
    const issues = [];
    if (health.conflicts?.length) issues.push(`${health.conflicts.length} conflicting claims`);
    if (health.staleSources) issues.push(`${health.staleSources} stale sources`);
    if (discovery?.lastError) issues.push("Refresh incomplete; previous evidence retained");
    else if (discovery?.truncated || discovery?.coverageComplete === false) issues.push("Partial discovery; dependencies may be missing");
    else if (!discovery?.at) issues.push("Discovery coverage not yet available");
    $("healthSummary").classList.toggle("warning", Boolean(health.conflicts?.length || health.staleSources || discovery?.lastError));
    setText($("healthSummary"), issues.length ? issues.join(". ") : `${formatCount(health.sourceCount)} sources · refreshed ${formatDate(discovery.at)}`);
  }

  function renderEntityList() {
    const list = $("entityList");
    const previousFocus = list.contains(document.activeElement) ? document.activeElement.dataset.nodeId : null;
    list.replaceChildren();
    for (const node of state.graph?.nodes || []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "entity-row";
      row.dataset.nodeId = node.id;
      row.setAttribute("aria-pressed", String(node.id === state.selectedId));
      for (const [className, text] of [["entity-name", node.label], ["entity-type", node.aggregate ? `${node.type} group` : node.type], ["entity-status", node.status || "—"]]) {
        const span = document.createElement("span"); span.className = className; span.textContent = text; span.title = text; row.append(span);
      }
      row.addEventListener("click", () => void selectNode(node.id));
      list.append(row);
      if (node.id === previousFocus) row.focus({ preventScroll: true });
    }
  }

  function rememberView() {
    state.navigation.push({ focus: state.focus, query: state.query, direction: state.direction, hops: state.hops, offset: state.offset,
      types: state.typeFilter ? [...state.typeFilter] : null, relations: state.relationFilter ? [...state.relationFilter] : null });
    if (state.navigation.length > 30) state.navigation.shift();
  }

  async function navigateTo(nodeId) {
    rememberView();
    state.focus = nodeId;
    state.selectedId = nodeId;
    state.query = ""; state.offset = 0; state.typeFilter = null; state.relationFilter = null; state.expandedType = "";
    $("searchInput").value = "";
    await loadGraph();
  }

  function arrangeGraph() {
    if (!state.cy?.nodes().length) return;
    const name = $("layoutSelect").value;
    const focus = state.cy.getElementById(state.focus || state.graph.project?.rootNodeId || "");
    state.cy.nodes().removeStyle();
    state.cy.layout({ name, animate: false, fit: false, randomize: false, padding: 50,
      nodeDimensionsIncludeLabels: true, avoidOverlap: true, spacingFactor: name === "grid" ? 1.12 : 1.1,
      ...(name === "grid" ? { cols: Math.max(1, Math.ceil(Math.sqrt(state.cy.nodes().length * state.cy.width() / Math.max(240, state.cy.height()) * 60 / 160))) } : {}),
      nodeRepulsion: () => 16000, idealEdgeLength: () => 110, componentSpacing: 100, numIter: 450,
      sort: (a, b) => Number(b.data("type") === "project") - Number(a.data("type") === "project") || String(a.data("type")).localeCompare(String(b.data("type"))) || String(a.data("label")).localeCompare(String(b.data("label"))),
      directed: true, ...(focus.length ? { roots: focus } : {}) }).run();
    state.cy.nodes().forEach(node => { state.positions[node.id()] = { ...node.position() }; });
    fitGraph(); savePositions();
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
    $("focusButton").disabled = !node || node.aggregate;
    for (const row of $("entityList").querySelectorAll("[data-node-id]")) row.setAttribute("aria-pressed", String(row.dataset.nodeId === node?.id));
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
    detailRow(summaryGrid, "Key", node.key || node.id);

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
    if (!node.aggregate) {
      const actions = document.createElement("div"); actions.className = "inspector-actions";
      for (const [label, run] of [["Explore relations", () => navigateTo(node.id)], ["Copy agent query", async () => {
        const text = JSON.stringify({ action: "impact", focus: node.id, hops: state.hops });
        try { await navigator.clipboard.writeText(text); setStatus("Copied project_intel impact query."); }
        catch { setStatus(text); }
      }]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "quiet"; button.textContent = label;
        button.addEventListener("click", run); actions.append(button);
      }
      inspectorContent.append(actions);
    }

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
        rememberView();
        state.offset = 0; state.focus = ""; state.query = ""; $("searchInput").value = "";
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
        meta.textContent = `${entry.scope || "shared"} · v${entry.version ?? "—"} · ${formatDate(entry.observedAt)}${entry.active === false ? " · withdrawn" : entry.stale ? " · stale" : ""}`;
        const sourceId = document.createElement("span"); sourceId.textContent = entry.sourceId || ""; item.append(sourceId);
        item.append(kind, locator, meta);
        list.append(item);
      }
      provenance.append(list);
    }
    inspectorContent.append(provenance);

    const edges = detailBlock("Nearby relations");
    const relationEntries = Array.isArray(details.edges) ? details.edges.slice(0, 60) : [];
    if (!relationEntries.length) {
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = "No direct relations in the current scope.";
      edges.append(copy);
    } else {
      const list = document.createElement("div");
      list.className = "relation-list";
      for (const edge of relationEntries) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "relation-link";
        const kind = document.createElement("span");
        kind.className = "relation-kind";
        kind.textContent = `${edge.type || "related"} · ${edge.status || "unknown"}`;
        const target = document.createElement("span");
        const outgoing = edge.source === node.id;
        target.textContent = outgoing ? `→ ${edge.targetLabel || edge.target}` : `← ${edge.sourceLabel || edge.source}`;
        item.append(kind, target);
        const evidence = edge.provenance?.[0];
        if (evidence) { const meta = document.createElement("span"); meta.className = "evidence-meta"; meta.textContent = `${evidence.locator} · v${evidence.version}`; item.append(meta); }
        item.addEventListener("click", () => void navigateTo(outgoing ? edge.target : edge.source));
        list.append(item);
      }
      edges.append(list);
    }
    if (details.edges?.length > relationEntries.length) { const more = document.createElement("p"); more.className = "muted small"; more.textContent = `Showing ${relationEntries.length} of ${details.counts?.edges ?? details.edges.length} relations. Explore the neighborhood or filter relation types.`; edges.append(more); }
    inspectorContent.append(edges);

    const facts = detailBlock("Literal facts");
    const factEntries = Array.isArray(details.facts) ? details.facts.slice(0, 40) : [];
    if (!factEntries.length) {
      const copy = document.createElement("p");
      copy.className = "muted small";
      copy.textContent = "No literal claims attached.";
      facts.append(copy);
    } else {
      const grid = document.createElement("div");
      for (const fact of factEntries) {
        const entry = document.createElement("div"); entry.className = `fact-entry${fact.conflict ? " fact-conflict" : ""}`;
        const key = document.createElement("strong"); key.textContent = `${fact.predicate || "fact"}${fact.conflict ? " · conflicting evidence" : ""}`;
        const value = document.createElement("p"); value.textContent = fact.object;
        const meta = document.createElement("span"); meta.className = "evidence-meta";
        meta.textContent = `${fact.status || "unknown"} · ${fact.provenance?.[0]?.locator || "no source"}`;
        entry.append(key, value, meta); grid.append(entry);
      }
      facts.append(grid);
    }
    inspectorContent.insertBefore(facts, provenance);
    inspectorContent.insertBefore(edges, provenance);

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
        label.textContent = entry.sourceId ? `${entry.sourceId} · ${formatDate(entry.at || entry.createdAt || entry.observedAt)}` : formatDate(entry.at || entry.createdAt || entry.observedAt);
        item.append(kind, label);
        list.append(item);
      }
      history.append(list);
      inspectorContent.append(history);
    }
  }

  async function selectNode(nodeId, options = {}) {
    const serial = ++state.detailSerial;
    state.selectedId = nodeId || "";
    const node = state.graph?.nodes?.find((entry) => entry.id === state.selectedId) || null;
    renderInspector(node);
    applyHighlight();
    updateSemanticLabels();
    if (!node || node.aggregate || options.loadDetails === false) return;
    try {
      const details = await fetchJson(`/api/node?id=${encodeURIComponent(node.id)}${state.includeInactive ? "&includeInactive=1" : ""}`);
      if (state.selectedId === node.id && serial === state.detailSerial) renderInspector({ ...node, ...details.node }, details.node ? { ...details.node, edges: details.edges, facts: details.facts, history: details.history, health: details.health, counts: details.counts } : details);
    } catch (error) {
      if (state.selectedId !== node.id || serial !== state.detailSerial) return;
      const message = document.createElement("p");
      message.className = "muted small";
      message.textContent = `Provenance unavailable: ${error.message}`;
      inspectorContent.append(message);
    }
  }

  function fitGraph() {
    if (!state.cy || !state.cy.nodes().length) return;
    state.cy.fit(state.cy.elements(), 40);
    if (state.cy.zoom() > 1.2) { state.cy.zoom(1.2); state.cy.center(); }
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
    state.cy.on("dragfree", "node", (event) => { state.positions[event.target.id()] = { ...event.target.position() }; savePositions(); });
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
    // Reconcile in place; preserve both manually dragged and layout positions.
    state.cy.nodes().forEach(node => { state.positions[node.id()] = { ...node.position() }; });
    const elements = makeCyElements(state.graph), ids = new Set(elements.map(element => element.data.id));
    state.cy.batch(() => {
      state.cy.elements().filter(element => !ids.has(element.id())).remove();
      for (const element of elements) {
        const existing = state.cy.getElementById(element.data.id);
        if (existing.length) existing.data(element.data); else state.cy.add(element);
      }
    });
    renderEntityList(); updateNavigation(state.graph);
    updateSemanticLabels();
    if (!state.selectedId || !state.graph.nodes.some((node) => node.id === state.selectedId)) {
      state.selectedId = "";
      renderInspector(null);
    }
    applyHighlight();
    if (!state.cy.nodes().length) { savePositions(); setStatus("No matching entities in this view."); return; }
    if (!state.hasFitted) { if (state.restoredPositions) fitGraph(); else arrangeGraph(); state.hasFitted = true; }
    if (state.selectedId) void selectNode(state.selectedId);
    savePositions();
    setStatus(`Live at revision ${state.revision}.`);
  }

  async function loadGraph() {
    clearTimeout(state.searchTimer);
    const serial = ++state.requestSerial;
    state.loading = true;
    setStatus("Reading the latest project graph…");
    try {
      const graph = await fetchJson(currentPath());
      if (serial !== state.requestSerial) return;
      renderGraph(graph);
      arrangeGraph();
      setConnection("connected", "Connected");
    } catch (error) {
      if (serial !== state.requestSerial) return;
      setConnection("error", "Disconnected");
      graphError.hidden = false;
      graphErrorMessage.textContent = error.message;
      setStatus("Viewer could not read the project. Retry when the local server is available.");
    } finally { if (serial === state.requestSerial) state.loading = false; }
  }

  async function pollGraph() {
    if (state.loading || state.polling) return;
    state.polling = true;
    const serial = state.requestSerial, path = currentPath("/api/poll");
    try {
      const reply = await fetchJson(path + `&since=${encodeURIComponent(state.revision)}`);
      if (serial !== state.requestSerial || path !== currentPath("/api/poll")) return;
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
      } else {
        graphError.hidden = true;
        setConnection("connected", "Connected");
      }
    } catch (error) {
      if (serial === state.requestSerial) { setConnection("error", "Reconnecting"); setStatus(error.message); }
    } finally { state.polling = false; }
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
      state.requestSerial++; state.loading = false;
      state.query = String(event.target.value || "").trim().slice(0, 120);
      state.offset = 0; state.focus = ""; state.selectedId = "";
      clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => void loadGraph(), 240);
    });
    $("directionSelect").addEventListener("change", (event) => { state.direction = event.target.value; if (state.focus) void loadGraph(); else applyHighlight(); });
    $("depthSelect").addEventListener("change", (event) => { state.hops = Number(event.target.value); if (state.focus) void loadGraph(); });
    focusSelect.addEventListener("change", (event) => void navigateTo(String(event.target.value || "")));
    $("focusButton").addEventListener("click", () => { if (state.selectedId) void navigateTo(state.selectedId); });
    $("fitButton").addEventListener("click", fitGraph);
    $("resetButton").addEventListener("click", () => { state.selectedId = ""; state.offset = 0; state.hops = 1; $("depthSelect").value = "1"; state.focus = ""; state.direction = "both"; state.query = ""; state.typeFilter = null; state.relationFilter = null; state.expandedType = ""; $("searchInput").value = ""; $("directionSelect").value = "both"; void loadGraph(); });
    $("clearFiltersButton").addEventListener("click", () => { state.offset = 0; state.typeFilter = null; state.expandedType = ""; void loadGraph(); });
    $("clearRelationFiltersButton").addEventListener("click", () => { state.offset = 0; state.relationFilter = null; void loadGraph(); });
    $("showAllButton").addEventListener("click", () => { state.offset = 0; state.typeFilter = null; state.relationFilter = null; state.expandedType = ""; void loadGraph(); });
    $("retryButton").addEventListener("click", () => { if (!state.started) void start(); else void loadGraph(); });
    $("arrangeButton").addEventListener("click", arrangeGraph);
    $("layoutSelect").addEventListener("change", arrangeGraph);
    $("inactiveToggle").addEventListener("change", event => { state.includeInactive = event.target.checked; state.offset = 0; void loadGraph(); });
    for (const [id, listView] of [["mapViewButton", false], ["listViewButton", true]]) $(id).addEventListener("click", () => {
      state.listView = listView; $("entityList").hidden = !listView; root.hidden = listView;
      $("mapViewButton").setAttribute("aria-pressed", String(!listView)); $("listViewButton").setAttribute("aria-pressed", String(listView));
      $("layoutSelect").disabled = listView; $("arrangeButton").disabled = listView;
      if (!listView) state.cy?.resize();
      savePositions();
    });
    $("nextPage").addEventListener("click", () => { state.offset += state.graph.page.size; void loadGraph(); });
    $("previousPage").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.graph.page.size); void loadGraph(); });
    $("backButton").addEventListener("click", () => {
      const view = state.navigation.pop(); if (!view) return;
      Object.assign(state, { focus: view.focus, selectedId: view.focus, query: view.query, direction: view.direction, hops: view.hops, offset: view.offset,
        typeFilter: view.types ? new Set(view.types) : null, relationFilter: view.relations ? new Set(view.relations) : null });
      $("searchInput").value = state.query; $("directionSelect").value = state.direction; $("depthSelect").value = String(state.hops);
      void loadGraph();
    });
    $("exportButton").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ ...state.graph, view: { focus: state.focus, query: state.query, direction: state.direction, hops: state.hops }, positions: state.positions }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "project-graph.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    document.addEventListener("keydown", event => { if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) { event.preventDefault(); $("searchInput").focus(); } });
    new ResizeObserver(() => state.cy?.resize()).observe(root);
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
    if (state.starting) return;
    state.starting = true;
    setConnection("connecting", "Connecting");
    if (!token) {
      setConnection("error", "Invalid link");
      graphError.hidden = false;
      graphErrorMessage.textContent = "This viewer link has no capability fragment. Reopen it from the /graph command.";
      setStatus("Viewer link is missing its private capability.");
      state.starting = false;
      return;
    }
    if (!state.wired) { wireControls(); state.wired = true; }
    try {
      let bootstrap = await fetchJson(currentPath("/api/bootstrap"));
      const project = bootstrap.project || {};
      state.storageKey = `project-intelligence:v2:${project.id || location.origin}:${project.checkoutId || "shared"}`;
      readPositions();
      try {
        const view = JSON.parse(localStorage.getItem(`${state.storageKey}:view`) || "null");
        if (view && typeof view === "object") {
          state.focus = typeof view.focus === "string" ? view.focus.slice(0, 512) : "";
          state.query = typeof view.query === "string" ? view.query.slice(0, 120) : "";
          state.direction = ["both", "incoming", "outgoing"].includes(view.direction) ? view.direction : "both";
          state.hops = [1, 2, 3, 4].includes(view.hops) ? view.hops : 1;
          state.typeFilter = Array.isArray(view.types) ? new Set(view.types.filter(type => typeof type === "string").slice(0, 20)) : null;
          state.relationFilter = Array.isArray(view.relations) ? new Set(view.relations.filter(type => typeof type === "string").slice(0, 20)) : null;
          state.includeInactive = view.includeInactive === true; $("inactiveToggle").checked = state.includeInactive;
          $("searchInput").value = state.query; $("directionSelect").value = state.direction; $("depthSelect").value = String(state.hops);
          if (["grid", "cose", "breadthfirst"].includes(view.layout)) $("layoutSelect").value = view.layout;
          state.selectedId = state.focus;
          if (view.listView) $("listViewButton").click();
          bootstrap = await fetchJson(currentPath());
        }
      } catch { /* An unavailable preference store does not prevent opening. */ }
      setText(projectTitle, project.name || "Project intelligence");
      setText(projectContext, [project.branch && `branch ${project.branch}`, project.checkoutId && `checkout ${project.checkoutId}`].filter(Boolean).join(" · ") || "Local project graph");
      setText($("serverVersion"), bootstrap.serverVersion || "Local read-only session");
      renderGraph(bootstrap);
      setConnection("connected", "Connected");
      await heartbeat(true);
      state.started = true;
      schedulePolling();
      window.setInterval(() => { void heartbeat(document.visibilityState !== "hidden"); }, 15_000);
    } catch (error) {
      setConnection("error", "Disconnected");
      graphError.hidden = false;
      graphErrorMessage.textContent = error.message;
      setStatus("Viewer could not start. Retry when the local server is available.");
    } finally { state.starting = false; }
  }

  void start();
})();
