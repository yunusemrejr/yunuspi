import { createHash } from 'node:crypto';
import { candidateRelevance } from '../local-intelligence.mjs';

const DEFAULT_HOPS = 1;
const DEFAULT_LIMIT = 16;
const DEFAULT_MAX_CHARS = 1800;
const MAX_HOPS = 12;
const MAX_LIMIT = 2000;
const MAX_QUERY_LENGTH = 512;
const MAX_PROVENANCE = 8;
const MAX_HEALTH_CONFLICTS = 32;

function hashText(value, length = 12) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function stringSet(value) {
  const result = new Set();
  for (const item of asArray(value)) {
    if (typeof item === 'string' && item.trim()) result.add(item.trim().toLowerCase());
  }
  return result;
}

function safeString(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : value === undefined || value === null ? '' : String(value).slice(0, max);
}

function tokenize(value) {
  return safeString(value, 4096).toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function normalizeQuery(value) {
  return safeString(value, MAX_QUERY_LENGTH).trim().toLocaleLowerCase();
}

function clampInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeDirection(value) {
  return value === 'incoming' || value === 'outgoing' || value === 'both' ? value : 'both';
}

function nodeText(node) {
  return `${node?.id ?? ''} ${node?.type ?? ''} ${node?.label ?? ''} ${node?.key ?? ''}`;
}

function edgeText(edge) {
  return `${edge?.type ?? ''} ${edge?.source ?? ''} ${edge?.target ?? ''}`;
}

function factText(fact) {
  return `${fact?.predicate ?? ''} ${fact?.object ?? ''} ${fact?.subject ?? ''}`;
}

function lexicalScore(text, query, queryTokens) {
  if (!query) return 0;
  const lower = safeString(text, 16384).toLocaleLowerCase();
  let score = 0;
  if (lower === query) score += 1000;
  if (lower.includes(query)) score += 120;
  const tokens = tokenize(text);
  const tokenSet = new Set(tokens);
  for (const token of queryTokens) {
    if (tokenSet.has(token)) score += 100;
    else if (tokens.some(item => item.startsWith(token))) score += 55;
    else if (tokens.some(item => item.includes(token))) score += 25;
    else if (lower.includes(token)) score += 10;
  }
  return score;
}

// Use the same ranking for agent retrieval and the visual panel. Score literal
// evidence on its subject; do not lose fact-only matches during root selection.
function rankMatches(graph, query, queryTokens, allTerms = false) {
  const textById = new Map(graph.nodes.map(node => [node.id, nodeText(node)]));
  for (const fact of graph.facts) textById.set(fact.subject, `${textById.get(fact.subject) ?? ""} ${factText(fact)}`);
  const scores = new Map(graph.nodes.map(node => [node.id, lexicalScore(nodeText(node), query, queryTokens)]));
  for (const node of graph.nodes) {
    if ([node.id, node.key, node.label].some(value => normalizeQuery(value) === query)) scores.set(node.id, 10000);
  }
  for (const fact of graph.facts) scores.set(fact.subject, (scores.get(fact.subject) ?? 0) + lexicalScore(factText(fact), query, queryTokens));
  for (const edge of graph.edges) {
    const score = lexicalScore(edge.type, query, queryTokens);
    for (const id of [edge.source, edge.target]) {
      scores.set(id, (scores.get(id) ?? 0) + score);
      textById.set(id, `${textById.get(id) ?? ''} ${edge.type}`);
    }
  }
  const degree = stableDegree(graph.edges);
  const eligible=graph.nodes.filter(node => scores.get(node.id) > 0 && (!allTerms || queryTokens.every(token => lexicalScore(textById.get(node.id), token, [token]) > 0))).sort((a,b)=>scores.get(b.id)-scores.get(a.id)||(degree.get(b.id)??0)-(degree.get(a.id)??0)||a.id.localeCompare(b.id));
  // Rerank at most 30 discovered candidates; exact identity and lexical score
  // tiers remain ahead of statistical relevance. Graph membership is intact.
  const candidates=eligible.slice(0,30);
  const relevance=process.env.PI_LOCAL_INTELLIGENCE==='off'?[]:candidateRelevance(candidates.map(node=>textById.get(node.id)),query);
  const ranked=new Map(candidates.map((node,i)=>[node.id,relevance[i]??0]));
  candidates.sort((a,b)=>scores.get(b.id)-scores.get(a.id) || ranked.get(b.id)-ranked.get(a.id) || (degree.get(b.id)??0)-(degree.get(a.id)??0) || a.id.localeCompare(b.id));
  return [...candidates,...eligible.slice(30)];
}

function exactFocus(graph, focus) {
  return [...new Set(asArray(focus).flatMap(value => {
    if (typeof value !== 'string' || !value) return [];
    const byId = graph.nodes.find(node => node.id === value);
    if (byId) return [byId.id];
    return graph.nodes.filter(node => node.key === value || node.label === value).map(node => node.id);
  }))].sort();
}

function sourceMap(snapshot) {
  return new Map(asArray(snapshot?.sources).filter(item => item && item.id).map(item => [item.id, item]));
}

function evidenceIsActive(item, sources, includeInactive) {
  if (includeInactive) return true;
  if (item && item.active === false) return false;
  const provenance = asArray(item?.provenance);
  if (provenance.length === 0) return true;
  return provenance.some(entry => {
    if (entry?.active === false || entry?.stale === true) return false;
    const source = sources.get(entry?.sourceId);
    return !source || (source.active !== false && source.stale !== true);
  });
}

function selectedProvenance(item, sources, includeInactive) {
  const provenance = asArray(item?.provenance).filter(entry => {
    if (includeInactive) return true;
    if (entry?.active === false || entry?.stale === true) return false;
    const source = sources.get(entry?.sourceId);
    return !source || (source.active !== false && source.stale !== true);
  });
  return provenance.slice(0, MAX_PROVENANCE);
}

function filteredGraph(snapshot, options) {
  const nodes = asArray(snapshot?.nodes).filter(Boolean);
  const edges = asArray(snapshot?.edges).filter(Boolean);
  const facts = asArray(snapshot?.facts).filter(Boolean);
  const sources = sourceMap(snapshot);
  const includeInactive = Boolean(options.includeInactive);
  const typeFilter = stringSet(options.types);
  const relationFilter = stringSet(options.relations);
  const scope = typeof options.scope === 'string' && options.scope.trim() ? options.scope.trim() : null;
  const scopeAllows = item => {
    if (!scope) return true;
    const provenance = asArray(item.provenance);
    if (provenance.length === 0) return true;
    return provenance.some(entry => entry.scope === scope || entry.scope === 'shared');
  };
  const filteredNodes = nodes.filter(node => !typeFilter.size || typeFilter.has(String(node.type ?? '').toLowerCase()));
  const allowedNodeIds = new Set(filteredNodes.map(node => node.id));
  const filteredEdges = edges.filter(edge => {
    if (!allowedNodeIds.has(edge.source) || !allowedNodeIds.has(edge.target)) return false;
    if (relationFilter.size && !relationFilter.has(String(edge.type ?? '').toLowerCase())) return false;
    return evidenceIsActive(edge, sources, includeInactive) && scopeAllows(edge);
  });
  const filteredFacts = facts.filter(fact => {
    if (!allowedNodeIds.has(fact.subject)) return false;
    if (relationFilter.size && !relationFilter.has(String(fact.predicate ?? '').toLowerCase())) return false;
    return evidenceIsActive(fact, sources, includeInactive) && scopeAllows(fact);
  });
  return { nodes: filteredNodes, edges: filteredEdges, facts: filteredFacts, sources };
}

function stableDegree(edges) {
  const degree = new Map();
  const add = id => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const edge of edges) { add(edge.source); add(edge.target); }
  return degree;
}

function resolveRoots(graph, options, query, queryTokens) {
  // An explicit missing focus or unmatched search is an empty answer, not an
  // unrelated project overview that could be mistaken for impact evidence.
  if (asArray(options.focus).some(Boolean)) return exactFocus(graph, options.focus);
  if (query) return rankMatches(graph, query, queryTokens).map(node => node.id);
  const projectId = graph.nodes.find(node => node.id === options?.projectNodeId || node.type === 'project')?.id;
  return projectId ? [projectId] : graph.nodes.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1).map(node => node.id);
}

function edgeSortKey(edge) {
  return String(edge.id ?? `${edge.source}:${edge.type}:${edge.target}`);
}

function buildAdjacency(edges) {
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of edges) {
    let from = outgoing.get(edge.source);
    if (!from) outgoing.set(edge.source, from = []);
    from.push(edge);
    let to = incoming.get(edge.target);
    if (!to) incoming.set(edge.target, to = []);
    to.push(edge);
  }
  for (const values of outgoing.values()) values.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
  for (const values of incoming.values()) values.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
  return { outgoing, incoming };
}

function adjacentEdges(adjacency, nodeIdValue, direction) {
  if (direction === 'incoming') return adjacency.incoming.get(nodeIdValue) ?? [];
  if (direction === 'outgoing') return adjacency.outgoing.get(nodeIdValue) ?? [];
  const values = [...(adjacency.outgoing.get(nodeIdValue) ?? []), ...(adjacency.incoming.get(nodeIdValue) ?? [])];
  return values.sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)));
}

function traverse(graph, roots, options, query, queryTokens) {
  const direction = normalizeDirection(options.direction);
  const hops = clampInteger(options.hops, DEFAULT_HOPS, 0, MAX_HOPS);
  const degree = stableDegree(graph.edges);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacency = buildAdjacency(graph.edges);
  const distances = new Map();
  const via = new Map();
  const queue = [];
  for (const root of roots) {
    if (!nodeById.has(root)) continue;
    distances.set(root, 0);
    queue.push(root);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const distance = distances.get(current) ?? 0;
    if (distance >= hops) continue;
    const edges = adjacentEdges(adjacency, current, direction);
    for (const edge of edges) {
      const next = edge.source === current && direction !== 'incoming' ? edge.target : edge.source;
      if (!nodeById.has(next) || distances.has(next)) continue;
      distances.set(next, distance + 1);
      via.set(next, edge.id);
      queue.push(next);
    }
  }
  const nodes = [...distances.keys()].map(id => nodeById.get(id)).filter(Boolean);
  nodes.sort((a, b) => {
    const distanceA = distances.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const distanceB = distances.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    const scoreA = lexicalScore(nodeText(a), query, queryTokens);
    const scoreB = lexicalScore(nodeText(b), query, queryTokens);
    return distanceA - distanceB || scoreB - scoreA || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id);
  });
  if(query && process.env.PI_LOCAL_INTELLIGENCE!=='off') {
    const candidates=nodes.slice(0,30), scores=candidateRelevance(candidates.map(nodeText),query);
    const relevance=new Map(candidates.map((node,i)=>[node.id,scores[i]]));
    candidates.sort((a,b)=>(distances.get(a.id)-distances.get(b.id)) ||
      lexicalScore(nodeText(b),query,queryTokens)-lexicalScore(nodeText(a),query,queryTokens) ||
      relevance.get(b.id)-relevance.get(a.id) || (degree.get(b.id)??0)-(degree.get(a.id)??0) || a.id.localeCompare(b.id));
    nodes.splice(0,candidates.length,...candidates);
  }
  return { nodes, distances, via };
}

function compactHealth(health) {
  if (!health || typeof health !== 'object') return {};
  const result = { ...health };
  if (Array.isArray(result.conflicts)) result.conflicts = result.conflicts.slice(0, MAX_HEALTH_CONFLICTS);
  return result;
}

function compactEvidence(item, sources, includeInactive) {
  const result = structuredClone(item);
  if (Array.isArray(item?.provenance)) result.provenance = selectedProvenance(item, sources, includeInactive);
  return result;
}

function summaryText(revision, query, focus, nodes, edges, facts, health, activity, truncated) {
  const subject = query ? `query=${JSON.stringify(query)}` : focus ? `focus=${JSON.stringify(focus)}` : 'project context';
  const nodeLabels = nodes.slice(0, 8).map(node => `${safeString(node.label || node.id, 72)}[${safeString(node.type, 32)}]`);
  const nodeById = new Map(nodes.map(node => [node.id, safeString(node.label || node.id, 72)]));
  const provenanceRef = item => {
    const provenance = asArray(item?.provenance)[0];
    if (!provenance) return '';
    return ` @${safeString(provenance.locator || provenance.sourceId, 48)}`;
  };
  const relationLabels = edges.slice(0, 8).map(edge => `${nodeById.get(edge.source) ?? safeString(edge.source, 24)} -${safeString(edge.type, 32)}-> ${nodeById.get(edge.target) ?? safeString(edge.target, 24)} [${safeString(edge.status, 18)}]${provenanceRef(edge)}`);
  const factLabels = facts.slice(0, 8).map(fact => `${nodeById.get(fact.subject) ?? safeString(fact.subject, 24)}.${safeString(fact.predicate, 32)}=${safeString(fact.object, 110)} [${safeString(fact.status, 18)}]${fact.conflict ? ' [conflict]' : ''}${provenanceRef(fact)}`);
  const conflictLabels = asArray(health?.conflicts).slice(0, 4).map(conflict => `${safeString(conflict.subject, 24)}.${safeString(conflict.predicate, 24)}: ${asArray(conflict.objects).map(item => safeString(item, 52)).join(' | ')}`);
  const activityLabels = asArray(activity).filter(item => item?.active !== false).slice(0, 3).map(item => {
    const label = safeString(item.label || item.id, 64);
    const checkout = item.checkoutId ? `@${safeString(item.checkoutId, 40)}` : '';
    return `${label}${checkout}`;
  });
  const sections = [
    `${!nodes.length && (query || focus) && !truncated ? 'No matching entities. ' : ''}${subject}; ${nodes.length} entities, ${edges.length} relations, ${facts.length} facts; revision ${revision}`,
    nodeLabels.length ? `entities: ${nodeLabels.join('; ')}` : '',
    relationLabels.length ? `relations: ${relationLabels.join('; ')}` : '',
    factLabels.length ? `facts: ${factLabels.join('; ')}` : '',
    conflictLabels.length ? `conflicts: ${conflictLabels.join('; ')}` : '',
    activityLabels.length ? `activity: ${activityLabels.join('; ')}` : '',
    truncated ? 'additional evidence omitted by the retrieval bound' : '',
  ].filter(Boolean);
  return sections.join(' | ');
}

function fitQueryBudget(result, budget) {
  const target = Math.max(96, budget);
  const candidate = result;
  const query = result._query;
  const focus = result._focus;
  const activity = result._activity;
  const serialize = value => JSON.stringify(value);
  const nodeIds = new Set(candidate.nodes.map(node => node.id));
  const trimDangling = () => {
    candidate.edges = candidate.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    candidate.facts = candidate.facts.filter(fact => nodeIds.has(fact.subject));
  };
  const rebuildSummary = () => {
    candidate.summary = summaryText(candidate.revision, query, focus, candidate.nodes, candidate.edges,
      candidate.facts, candidate.health, activity, Boolean(candidate.truncated));
  };
  const fitSummary = () => {
    rebuildSummary();
    const shell = { ...candidate, summary: '' };
    const room = target - serialize(shell).length - 2;
    if (room <= 0) candidate.summary = '';
    else if (candidate.summary.length > room) candidate.summary = `${candidate.summary.slice(0, Math.max(0, room - 1))}…`;
  };

  // Private ranking context is never part of the public query result and must
  // not consume the character budget.
  delete candidate._query;
  delete candidate._focus;
  delete candidate._activity;
  if (serialize(candidate).length <= target) return candidate;

  candidate.truncated = true;
  // Provenance is valuable, but one compact source reference is more useful
  // than dropping every relationship/fact to make room for repeated entries.
  for (const item of [...candidate.edges, ...candidate.facts]) {
    if (Array.isArray(item.provenance) && item.provenance.length > 1) item.provenance = item.provenance.slice(0, 1);
  }
  if (Array.isArray(candidate.health?.conflicts)) {
    candidate.health = { ...candidate.health, conflicts: candidate.health.conflicts.slice(0, 1) };
  }
  for (const node of candidate.nodes) {
    if (node.label && node.label.length > 96) node.label = `${node.label.slice(0, 93)}...`;
  }
  for (const fact of candidate.facts) {
    if (fact.object && fact.object.length > 256) fact.object = `${fact.object.slice(0, 253)}...`;
  }
  trimDangling();

  // Reserve room for evidence before reducing the node list. Without a small
  // evidence reservation, a large set of otherwise useful labels can force
  // every relationship out of the bounded result.
  const edgeBudget = Math.max(1, Math.floor(target / 700));
  const factBudget = Math.max(1, Math.floor(target / 700));
  if (candidate.edges.length > edgeBudget) candidate.edges.length = edgeBudget;
  if (candidate.facts.length > factBudget) candidate.facts.length = factBudget;
  const protectedNodeIds = new Set(candidate.nodes.slice(0, 1).map(node => node.id));
  for (const edge of candidate.edges) {
    protectedNodeIds.add(edge.source);
    protectedNodeIds.add(edge.target);
  }
  for (const fact of candidate.facts) protectedNodeIds.add(fact.subject);
  fitSummary();

  // Keep the highest-ranked nodes first. Removing tail nodes also removes
  // dangling evidence, which preserves relationships between the surviving
  // relevant nodes instead of spending the whole budget on isolated labels.
  while (serialize(candidate).length > target && candidate.nodes.length > 1) {
    let removeIndex = candidate.nodes.length - 1;
    while (removeIndex > 0 && protectedNodeIds.has(candidate.nodes[removeIndex].id)) removeIndex--;
    if (removeIndex <= 0 && protectedNodeIds.has(candidate.nodes[0].id)) break;
    const [removed] = candidate.nodes.splice(removeIndex, 1);
    nodeIds.delete(removed.id);
    trimDangling();
    fitSummary();
  }
  // Remove lower-priority evidence tails only after the node set has been
  // reduced, preserving matching relations and facts whenever possible.
  while (serialize(candidate).length > target && candidate.edges.length > 1) {
    candidate.edges.pop();
    fitSummary();
  }
  while (serialize(candidate).length > target && candidate.facts.length > 1) {
    candidate.facts.pop();
    fitSummary();
  }
  if (serialize(candidate).length > target) {
    for (const item of [...candidate.edges, ...candidate.facts]) delete item.provenance;
    fitSummary();
  }
  if (serialize(candidate).length > target && candidate.health && Object.keys(candidate.health).length) {
    candidate.health = {};
    fitSummary();
  }
  // Long literals and labels are the next bounded representation to shrink;
  // their subject/predicate and node identity remain available to the model.
  if (serialize(candidate).length > target) {
    for (const node of candidate.nodes) {
      if (node.label && node.label.length > 48) node.label = `${node.label.slice(0, 45)}...`;
    }
    for (const fact of candidate.facts) {
      if (fact.object && fact.object.length > 96) fact.object = `${fact.object.slice(0, 93)}...`;
    }
    fitSummary();
  }
  while (serialize(candidate).length > target && candidate.edges.length) {
    candidate.edges.pop();
    fitSummary();
  }
  while (serialize(candidate).length > target && candidate.facts.length) {
    candidate.facts.pop();
    fitSummary();
  }
  while (serialize(candidate).length > target && candidate.nodes.length > 1) {
    let removeIndex = candidate.nodes.length - 1;
    while (removeIndex > 0 && protectedNodeIds.has(candidate.nodes[removeIndex].id)) removeIndex--;
    if (removeIndex <= 0 && protectedNodeIds.has(candidate.nodes[0].id)) break;
    const [removed] = candidate.nodes.splice(removeIndex, 1);
    nodeIds.delete(removed.id);
    trimDangling();
    fitSummary();
  }
  if (serialize(candidate).length > target && candidate.nodes.length) {
    candidate.nodes = [];
    candidate.edges = [];
    candidate.facts = [];
    candidate.health = {};
    fitSummary();
  }
  // At extremely small caller budgets even the required result shell can be
  // larger than the requested summary. Keep the stable envelope and truncate
  // only its free text as a final hard bound.
  if (serialize(candidate).length > target) {
    candidate.summary = '';
    const room = Math.max(0, target - serialize({ ...candidate, summary: '' }).length - 2);
    if (room > 0) candidate.summary = `${summaryText(candidate.revision, query, focus, [], [], [], {}, activity, true).slice(0, Math.max(0, room - 1))}…`;
  }
  if (serialize(candidate).length > target) candidate.summary = '';
  return candidate;
}

/** Return a bounded, deterministic subgraph suitable for model context. */
export function queryGraph(snapshot, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const query = normalizeQuery(safeOptions.query);
  const queryTokens = tokenize(query);
  const limit = clampInteger(safeOptions.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxChars = clampInteger(safeOptions.maxChars, DEFAULT_MAX_CHARS, 96, 200000);
  const graph = filteredGraph(snapshot ?? {}, safeOptions);
  const candidates = resolveRoots({ ...graph, projectNodeId: snapshot?.project?.rootNodeId }, safeOptions, query, queryTokens);
  const roots = query && !safeOptions.focus ? candidates.slice(0, Math.min(4, limit)) : candidates;
  const traversed = traverse(graph, roots, safeOptions, query, queryTokens);
  const selectedNodes = traversed.nodes.slice(0, limit);
  const selectedIds = new Set(selectedNodes.map(node => node.id));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const edges = graph.edges.filter(edge => selectedIds.has(edge.source) && selectedIds.has(edge.target)).sort((a, b) => {
    const scoreA = lexicalScore(`${edgeText(a)} ${nodeText(nodeById.get(a.source))} ${nodeText(nodeById.get(a.target))}`, query, queryTokens);
    const scoreB = lexicalScore(`${edgeText(b)} ${nodeText(nodeById.get(b.source))} ${nodeText(nodeById.get(b.target))}`, query, queryTokens);
    return scoreB - scoreA || String(a.id ?? `${a.source}:${a.type}:${a.target}`).localeCompare(String(b.id ?? `${b.source}:${b.type}:${b.target}`));
  });
  const facts = graph.facts.filter(fact => selectedIds.has(fact.subject)).sort((a, b) => {
    const scoreA = lexicalScore(factText(a), query, queryTokens);
    const scoreB = lexicalScore(factText(b), query, queryTokens);
    return scoreB - scoreA || String(a.id ?? '').localeCompare(String(b.id ?? ''));
  }).slice(0, limit);
  const relevantFacts = graph.facts.filter(fact => selectedIds.has(fact.subject));
  const omittedByLimit = candidates.length > roots.length || traversed.nodes.length > selectedNodes.length || relevantFacts.length > facts.length;
  const result = {
    revision: Number(snapshot?.revision ?? 0),
    nodes: selectedNodes.map(node => ({ ...node, distance: traversed.distances.get(node.id), ...(traversed.via.has(node.id) ? { via: traversed.via.get(node.id) } : {}) })),
    edges: edges.map(edge => compactEvidence(edge, graph.sources, Boolean(safeOptions.includeInactive))),
    facts: facts.map(fact => compactEvidence(fact, graph.sources, Boolean(safeOptions.includeInactive))),
    health: compactHealth(snapshot?.health),
    truncated: Boolean(omittedByLimit),
    summary: summaryText(Number(snapshot?.revision ?? 0), query, safeOptions.focus, selectedNodes, edges, facts, snapshot?.health, snapshot?.activity, Boolean(omittedByLimit)),
    _query: query,
    _focus: safeOptions.focus,
    _activity: snapshot?.activity,
  };
  const fitted = fitQueryBudget(result, maxChars);
  fitted.truncated = Boolean(fitted.truncated || omittedByLimit || fitted.nodes.length < selectedNodes.length || fitted.edges.length < edges.length || fitted.facts.length < facts.length);
  const retainedEdges = new Set(fitted.edges.map(edge => edge.id));
  for (const node of fitted.nodes) if (node.via && !retainedEdges.has(node.via)) delete node.via;
  return fitted;
}

/** Agent context has its own text budget: serializing the full graph first can
 * consume the entire allowance before any relationships reach the model. Keep
 * exact keys, directions and evidence together, and only omit complete lines. */
export function agentBrief(snapshot, options = {}) {
  const maxChars = clampInteger(options.maxChars, 1800, 400, 6000);
  const graph = queryGraph(snapshot, { ...options, maxChars: 200000, limit: Math.min(40, options.limit ?? 16) });
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const label = id => safeString(byId.get(id)?.key || byId.get(id)?.label || id, 160);
  const evidence = item => {
    const source = asArray(item.provenance)[0];
    return `[${safeString(item.status || 'unknown', 18)}${item.conflict ? ', conflict' : ''}]${source ? ` @${safeString(source.locator || source.sourceId, 140)}` : ' [source unavailable]'}`;
  };
  const focus = asArray(options.focus).filter(value => typeof value === 'string').slice(0, 2).map(value => safeString(value,120));
  const roots = graph.nodes.filter(node => node.distance === 0);
  const header = `revision ${graph.revision}; ${focus.length ? `focus=${JSON.stringify(focus)}` : `query=${JSON.stringify(safeString(options.query, 180))}`}`;
  const result = {revision:graph.revision, summary:'', truncated:Boolean(graph.truncated)};
  const lines = [header, 'Incoming links identify consumers; outgoing links identify dependencies. Verify inferred links in source.'];
  if (options.caveat) lines.push(safeString(options.caveat, 180));
  if (!roots.length) lines.push('No matching entities. Missing evidence is not proof of no dependency.');
  const edgeLine = edge => `${label(edge.source)} -${safeString(edge.type, 40)}-> ${label(edge.target)} ${evidence(edge)}`;
  // Interleave both directions so a high-degree consumer cannot crowd out all
  // dependencies (or vice versa). Traversal retains transitive relationships.
  const rootIds = new Set(roots.map(node => node.id));
  const relationPriority = edge => ['contains','declares','modified'].includes(edge.type) ? 1 : 0;
  const edges = graph.edges.slice().sort((a,b) => relationPriority(a)-relationPriority(b));
  const incoming = edges.filter(edge => rootIds.has(edge.target));
  const outgoing = edges.filter(edge => rootIds.has(edge.source));
  const near = [], seen = new Set();
  for (let i = 0; i < Math.max(incoming.length,outgoing.length); i++) {
    for (const edge of [incoming[i],outgoing[i]]) if (edge && !seen.has(edge.id)) { seen.add(edge.id); near.push(edge); }
  }
  const facts = graph.facts.map(fact => `${label(fact.subject)}.${safeString(fact.predicate,40)}=${safeString(fact.object,180)} ${evidence(fact)}`);
  const candidates = [
    ...roots.map(node => `entity: ${label(node.id)} [${node.type}]`),
    ...near.slice(0,2).map(edgeLine),
    ...facts.filter((_,i) => graph.facts[i].conflict),
    ...edges.filter(edge => !seen.has(edge.id)).map(edgeLine),
    ...near.slice(2).map(edgeLine),
    ...facts.filter((_,i) => !graph.facts[i].conflict),
  ];
  const omitted = 'Additional evidence omitted; use project_intel with focus and direction to inspect more.';
  for (const line of candidates) {
    if (JSON.stringify({...result,summary:[...lines,line,omitted].join('\n')}).length > maxChars) { result.truncated=true; continue; }
    lines.push(line);
  }
  if (result.truncated) lines.push(omitted);
  result.summary=lines.join('\n');
  // Keep warnings intact even if supplied keys fill the header allowance.
  if (JSON.stringify(result).length > maxChars) {
    result.truncated=true;
    result.summary=[`revision ${graph.revision}; target label omitted`, options.caveat ? safeString(options.caveat,120) : '', omitted].filter(Boolean).join('\n');
  }
  return result;
}

function positionFor(id, index) {
  const digest = hashText(id, 16);
  const first = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  const second = Number.parseInt(digest.slice(8, 16), 16) / 0xffffffff;
  return { x: Math.round((first * 2 - 1) * 480 + ((index % 7) - 3) * 4), y: Math.round((second * 2 - 1) * 320 + (Math.floor(index / 7) % 7) * 4) };
}

function aggregateNode(type, count) {
  const id = `aggregate:${hashText(type, 16)}`;
  return { id, type: 'aggregate', aggregateFor: type, label: `${type} (${count})`, count, aggregate: true };
}

// A whole-project overview is a semantic map rather than a flat sample of
// the most connected nodes. Keep high-level categories represented before
// filling the remaining slots, then cap dense implementation categories so a
// large source tree cannot crowd out deployment and product context.
const OVERVIEW_PRIORITY_TYPES = Object.freeze([
  'project', 'repository', 'branch', 'feature', 'component', 'api', 'database',
  'table', 'configuration', 'pipeline', 'environment', 'infrastructure',
  'dependency', 'issue', 'constraint', 'decision', 'change', 'external',
  'directory', 'file', 'session',
]);
const OVERVIEW_DEFAULT_TYPE_CAP = 8;

function selectOverviewNodes(ranked, projectId, actualLimit) {
  const selected = [];
  const selectedIds = new Set();
  const counts = new Map();
  const add = node => {
    if (!node || selected.length >= actualLimit || selectedIds.has(node.id)) return false;
    const type = String(node.type ?? '').toLowerCase();
    const cap = type === 'project' ? 1 : OVERVIEW_DEFAULT_TYPE_CAP;
    if ((counts.get(type) ?? 0) >= cap) return false;
    selected.push(node);
    selectedIds.add(node.id);
    counts.set(type, (counts.get(type) ?? 0) + 1);
    return true;
  };

  // The canonical project node remains the center even when its degree is
  // lower than a large directory or component fan-out.
  add(ranked.find(node => node.id === projectId));
  for (const type of OVERVIEW_PRIORITY_TYPES) {
    if (selected.length >= actualLimit) break;
    add(ranked.find(node => String(node.type ?? '').toLowerCase() === type));
  }
  for (const node of ranked) add(node);

  // Preserve the existing relevance order for layout stability after the
  // category reservation pass.
  const rank = new Map(ranked.map((node, index) => [node.id, index]));
  selected.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  return selected;
}

/** Collapse a large snapshot into a stable viewer graph with bounded aggregation. */
export function simplifyGraph(snapshot, options = {}) {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const limit = clampInteger(safeOptions.limit, 220, 1, MAX_LIMIT);
  const graph = filteredGraph(snapshot ?? {}, { ...safeOptions, includeInactive: Boolean(safeOptions.includeInactive) });
  const query = normalizeQuery(safeOptions.query);
  const queryTokens = tokenize(query);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const degree = stableDegree(graph.edges);
  const projectId = snapshot?.project?.rootNodeId && nodeById.has(snapshot.project.rootNodeId)
    ? snapshot.project.rootNodeId
    : graph.nodes.find(node => node.type === 'project')?.id;
  const focusIds = exactFocus(graph, safeOptions.focus);
  const explicitFocus = focusIds[0];
  const wholeProjectOverview = !query && !stringSet(safeOptions.types).size &&
    !stringSet(safeOptions.relations).size && (!safeOptions.focus || Boolean(explicitFocus && explicitFocus === projectId));
  const direction = normalizeDirection(safeOptions.direction);
  const hops = clampInteger(safeOptions.hops, 1, 0, 4);
  let ranked;
  if (safeOptions.focus && !wholeProjectOverview) {
    ranked = traverse(graph, focusIds, { direction, hops }, '', []).nodes;
  } else if (query) {
    ranked = rankMatches(graph, query, queryTokens, true);
  } else {
    ranked = graph.nodes.slice().sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  }
  // Search results and focused neighborhoods are exact slices. Only the
  // overview/category browser aggregates nodes outside its current page.
  const aggregateBudget = query || safeOptions.focus && !wholeProjectOverview ? 0 : Math.min(16, Math.max(0, Math.floor(limit * 0.08)));
  const actualLimit = Math.max(1, limit - aggregateBudget);
  const offset = wholeProjectOverview || safeOptions.focus ? 0 : clampInteger(safeOptions.offset, 0, 0, MAX_LIMIT * 1000);
  const selectedActual = wholeProjectOverview
    ? selectOverviewNodes(ranked, projectId, actualLimit)
    : ranked.slice(offset, offset + actualLimit);
  const selectedIds = new Set(selectedActual.map(node => node.id));
  const hidden = ranked.filter(node => !selectedIds.has(node.id));
  const hiddenByType = new Map();
  for (const node of hidden) hiddenByType.set(node.type, (hiddenByType.get(node.type) ?? 0) + 1);
  const aggregateTypes = [...hiddenByType.keys()].sort((a, b) => a.localeCompare(b)).slice(0, aggregateBudget);
  const aggregates = aggregateTypes.map(type => aggregateNode(type, hiddenByType.get(type)));
  const aggregateByType = new Map(aggregates.map(node => [node.aggregateFor, node]));
  const outputNodes = [...selectedActual.map((node, index) => ({ ...node, aggregate: false, ...positionFor(node.id, index) })),
    ...aggregates.map((node, index) => ({ ...node, ...positionFor(node.id, selectedActual.length + index) }))];
  const outputEdges = new Map();
  const addEdge = edge => {
    const id = edge.id ?? `edge:${hashText(`${edge.source}\u0000${edge.type}\u0000${edge.target}`, 24)}`;
    if (!outputEdges.has(id)) outputEdges.set(id, { ...edge, id, ...(edge.aggregated ? { count: 1 } : {}) });
    else if (edge.aggregated) outputEdges.get(id).count++;
  };
  for (const edge of graph.edges) {
    const sourceVisible = selectedIds.has(edge.source);
    const targetVisible = selectedIds.has(edge.target);
    if (sourceVisible && targetVisible) {
      addEdge(compactEvidence(edge, graph.sources, Boolean(safeOptions.includeInactive)));
      continue;
    }
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const replacementSource = sourceVisible ? edge.source : aggregateByType.get(sourceNode?.type)?.id;
    const replacementTarget = targetVisible ? edge.target : aggregateByType.get(targetNode?.type)?.id;
    if (!replacementSource || !replacementTarget || replacementSource === replacementTarget) continue;
    addEdge({
      id: `aggregate-edge:${hashText(`${replacementSource}\u0000${edge.type}\u0000${replacementTarget}`, 24)}`,
      source: replacementSource,
      target: replacementTarget,
      type: edge.type,
      aggregated: true,
    });
  }
  const edges = [...outputEdges.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.max(32, limit * 4));
  const byType = {};
  for (const node of graph.nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const clusters = aggregateTypes.map(type => ({ id: `cluster:${hashText(type, 16)}`, type, count: hiddenByType.get(type), hidden: true }));
  const counts = {
    nodes: graph.nodes.length,
    actualNodes: selectedActual.length,
    aggregateNodes: aggregates.length,
    hiddenNodes: hidden.length,
    edges: graph.edges.length,
    visibleEdges: edges.length,
    facts: graph.facts.length,
    byType,
  };
  return {
    revision: Number(snapshot?.revision ?? 0),
    project: snapshot?.project ?? null,
    nodes: outputNodes,
    edges,
    health: { ...compactHealth(snapshot?.health), hiddenNodes: hidden.length },
    activity: asArray(snapshot?.activity),
    counts,
    page: { offset, size: actualLimit, total: ranked.length, hasMore: !wholeProjectOverview && offset + selectedActual.length < ranked.length },
    clusters,
  };
}
