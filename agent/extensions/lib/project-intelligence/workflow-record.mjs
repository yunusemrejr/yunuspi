import { createHash } from "node:crypto";
import { nodeId } from "./store.mjs";

/*
 * Workflow references are identifiers observed at a hook boundary.  They are
 * deliberately kept separate from the transcript and from Git state: a
 * conversation branch or a native checkpoint is not a commit, and a review
 * observation is not an approval or a correctness result.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/u;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/iu;
const REQUEST_PATTERN = /^[a-f0-9]{24,64}$/iu;
const BRANCH_PATTERN = /^(?![.-])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9._/-]{1,160}$/u;
const REVIEW_ASPECTS = new Set(["correctness", "security", "interface", "content", "runtime", "delivery"]);
const REVIEW_OUTCOMES = new Set(["pass", "changes", "unknown"]);

function fail(message, code = "WORKFLOW_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(`${label} must be an object.`);
  return value;
}

function id(value, label, pattern = ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value))
    throw fail(`${label} is invalid.`);
  return value;
}

function optionalId(value, label, pattern = ID_PATTERN) {
  if (value === undefined || value === null || value === "") return undefined;
  return id(value, label, pattern);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function identityValues(identity, sessionId) {
  return {
    projectId: id(identity?.id, "worker project identity"),
    checkoutId: id(identity?.checkoutId, "worker checkout identity"),
    sessionId: id(sessionId, "worker session identity"),
  };
}

/**
 * Validate and project the workflow envelope to its reference-only shape.
 * Unknown fields are intentionally discarded, so prompt/council prose cannot
 * become durable graph data by accident.
 */
export function normalizeWorkflow(workflow, { identity, sessionId } = {}) {
  if (workflow === undefined || workflow === null) return undefined;
  object(workflow, "workflow");
  const owner = identityValues(identity, sessionId);
  const projectId = id(workflow.projectId, "workflow.projectId");
  const checkoutId = id(workflow.checkoutId, "workflow.checkoutId");
  const conversation = object(workflow.conversation, "workflow.conversation");
  const conversationSession = id(conversation.sessionId, "workflow.conversation.sessionId");
  if (projectId !== owner.projectId || checkoutId !== owner.checkoutId || conversationSession !== owner.sessionId)
    throw fail("Workflow references a different project, checkout or conversation.", "WORKFLOW_SCOPE_MISMATCH");

  const result = {
    projectId,
    checkoutId,
    conversation: {
      sessionId: conversationSession,
      branchHead: optionalId(conversation.branchHead, "workflow.conversation.branchHead"),
      latestUserEntry: optionalId(conversation.latestUserEntry, "workflow.conversation.latestUserEntry"),
    },
  };

  if (!result.conversation.branchHead && !result.conversation.latestUserEntry)
    throw fail("Workflow conversation must identify a branch or latest user entry.");

  if (conversation.nativeCheckpoint !== undefined && conversation.nativeCheckpoint !== null) {
    const checkpoint = object(conversation.nativeCheckpoint, "workflow.conversation.nativeCheckpoint");
    const entryId = id(checkpoint.entryId, "workflow.conversation.nativeCheckpoint.entryId");
    const beforeCommit = optionalId(checkpoint.beforeCommit, "workflow.conversation.nativeCheckpoint.beforeCommit", SHA_PATTERN);
    const afterCommit = optionalId(checkpoint.afterCommit, "workflow.conversation.nativeCheckpoint.afterCommit", SHA_PATTERN);
    if (!beforeCommit && !afterCommit)
      throw fail("Native checkpoint must reference a before or after commit.");
    result.conversation.nativeCheckpoint = {
      entryId,
      ...(beforeCommit ? { beforeCommit } : {}),
      ...(afterCommit ? { afterCommit } : {}),
    };
  }

  const projectGit = object(workflow.projectGit, "workflow.projectGit");
  const head = optionalId(projectGit.head, "workflow.projectGit.head", SHA_PATTERN);
  let branch;
  if (projectGit.branch !== undefined && projectGit.branch !== null && projectGit.branch !== "") {
    if (projectGit.branch !== "(detached)") branch = id(projectGit.branch, "workflow.projectGit.branch", BRANCH_PATTERN);
  }
  result.projectGit = {
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
  };
  if (!head && !branch && projectGit.status !== "unavailable" && projectGit.status !== "not a Git checkout at discovery")
    throw fail("Workflow projectGit must identify a head, branch or unavailable state.");

  if (workflow.scope !== undefined && workflow.scope !== null) {
    const scope = object(workflow.scope, "workflow.scope");
    result.scope = { requestHash: id(scope.requestHash, "workflow.scope.requestHash", REQUEST_PATTERN) };
  }
  return result;
}

/** Stable reference identity used in change/source keys. */
export function workflowIdentity(workflow) {
  if (!workflow) return undefined;
  return hash(JSON.stringify([
    workflow.projectId,
    workflow.checkoutId,
    workflow.conversation.sessionId,
    workflow.conversation.branchHead ?? "",
    workflow.conversation.latestUserEntry ?? "",
    workflow.scope?.requestHash ?? "",
  ])).slice(0, 32);
}

/** Include branch/request identity in a change source key when available. */
export function changeRecordKey({ sessionId, files, workflow } = {}) {
  const session = id(sessionId, "change session");
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string"))
    throw fail("change files must be an array of strings.");
  const fileDigest = hash(files.join("\n")).slice(0, 16);
  const base = `session-change:${session}:${fileDigest}`;
  if (!workflow) return base;
  return `${base}:${workflowIdentity(workflow).slice(0, 24)}`;
}

function referenceNodes(workflow) {
  const { projectId, checkoutId, conversation } = workflow;
  const conversationKey = `${projectId}:conversation:${checkoutId}:${conversation.sessionId}`;
  const conversationNode = {
    id: nodeId("session", conversationKey),
    type: "session",
    key: conversationKey,
    label: `Conversation ${conversation.sessionId.slice(0, 12)}`,
  };
  const nodes = [conversationNode];
  let branchNode;
  if (conversation.branchHead) {
    const key = `${conversationKey}:branch:${conversation.branchHead}`;
    branchNode = {
      id: nodeId("session", key),
      type: "session",
      key,
      label: `Conversation branch ${conversation.branchHead.slice(0, 12)}`,
    };
    nodes.push(branchNode);
  }
  let requestNode;
  if (workflow.scope?.requestHash) {
    const key = `${conversationKey}:request:${workflow.scope.requestHash}`;
    requestNode = {
      id: nodeId("session", key),
      type: "session",
      key,
      label: `Request ${workflow.scope.requestHash.slice(0, 12)}`,
    };
    nodes.push(requestNode);
  }
  let checkpointNode;
  const checkpoint = conversation.nativeCheckpoint;
  if (checkpoint) {
    const key = `${conversationKey}:checkpoint:${checkpoint.entryId}`;
    checkpointNode = {
      id: nodeId("checkpoint", key),
      type: "checkpoint",
      key,
      label: `Native checkpoint ${checkpoint.entryId.slice(0, 12)}`,
    };
    nodes.push(checkpointNode);
  }
  return { nodes, conversationNode, branchNode, requestNode, checkpointNode };
}

function existingSet(existingNodes) {
  if (existingNodes instanceof Set) return existingNodes;
  if (Array.isArray(existingNodes)) return new Set(existingNodes.map((node) => typeof node === "string" ? node : node?.id).filter(Boolean));
  return new Set();
}

function relation(subject, predicate, objectId, claims) {
  if (!subject || !objectId) return;
  claims.push({ subject, predicate, object: objectId, relation: true, status: "historical", confidence: 0.95 });
}

function addReferenceClaims(workflow, refs, existingNodes, claims) {
  relation(refs.branchNode?.id, "branch_of_conversation", refs.conversationNode.id, claims);
  relation(refs.requestNode?.id, "request_on_branch", refs.branchNode?.id ?? refs.conversationNode.id, claims);
  relation(refs.checkpointNode?.id, "checkpoint_on_branch", refs.branchNode?.id ?? refs.conversationNode.id, claims);
  const known = existingSet(existingNodes);
  const branchId = workflow.projectGit.branch
    ? nodeId("branch", `${workflow.projectId}:branch:${workflow.projectGit.branch}`)
    : undefined;
  const commitId = workflow.projectGit.head
    ? nodeId("change", `${workflow.projectId}:commit:${workflow.projectGit.head}`)
    : undefined;
  if (branchId && known.has(branchId)) relation(refs.branchNode?.id ?? refs.conversationNode.id, "observed_project_git_branch", branchId, claims);
  if (commitId && known.has(commitId)) relation(refs.checkpointNode?.id ?? refs.requestNode?.id ?? refs.branchNode?.id ?? refs.conversationNode.id, "observed_project_git_commit", commitId, claims);
  if (workflow.projectGit.branch) claims.push({
    subject: refs.branchNode?.id ?? refs.conversationNode.id,
    predicate: "observed_project_git_branch_name",
    object: workflow.projectGit.branch,
    relation: false,
    status: "historical",
    confidence: 0.95,
  });
  if (workflow.projectGit.head) claims.push({
    subject: refs.checkpointNode?.id ?? refs.requestNode?.id ?? refs.branchNode?.id ?? refs.conversationNode.id,
    predicate: "observed_project_git_head",
    object: workflow.projectGit.head,
    relation: false,
    status: "historical",
    confidence: 0.95,
  });
  const checkpoint = workflow.conversation.nativeCheckpoint;
  if (checkpointNodeCommit(checkpoint, "beforeCommit")) {
    const beforeId = nodeId("change", `${workflow.projectId}:commit:${checkpoint.beforeCommit}`);
    if (known.has(beforeId)) relation(refs.checkpointNode?.id, "native_before_git_reference", beforeId, claims);
    if (refs.checkpointNode) claims.push({ subject: refs.checkpointNode.id, predicate: "native_before_commit", object: checkpoint.beforeCommit, relation: false, status: "historical", confidence: 0.95 });
  }
  if (checkpointNodeCommit(checkpoint, "afterCommit")) {
    const afterId = nodeId("change", `${workflow.projectId}:commit:${checkpoint.afterCommit}`);
    if (known.has(afterId)) relation(refs.checkpointNode?.id, "native_after_git_reference", afterId, claims);
    if (refs.checkpointNode) claims.push({ subject: refs.checkpointNode.id, predicate: "native_after_commit", object: checkpoint.afterCommit, relation: false, status: "historical", confidence: 0.95 });
  }
}

function checkpointNodeCommit(checkpoint, field) {
  return Boolean(checkpoint && checkpoint[field]);
}

/** Build reference-only nodes/claims for one observed file-change receipt. */
export function buildChangeProvenance({ workflow, changeId, existingNodes } = {}) {
  if (!workflow) return { nodes: [], claims: [], identity: undefined };
  const change = id(changeId, "change node");
  const refs = referenceNodes(workflow);
  const claims = [];
  relation(change, "observed_in_conversation", refs.branchNode?.id ?? refs.conversationNode.id, claims);
  relation(change, "for_request", refs.requestNode?.id, claims);
  relation(change, "has_native_checkpoint", refs.checkpointNode?.id, claims);
  addReferenceClaims(workflow, refs, existingNodes, claims);
  return { nodes: refs.nodes, claims, identity: workflowIdentity(workflow), references: refs };
}

function reviewSample(sample) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample) || !REVIEW_ASPECTS.has(sample.aspect) || !REVIEW_OUTCOMES.has(sample.outcome))
    throw fail("Invalid review observation.");
  return { aspect: sample.aspect, outcome: sample.outcome };
}

/** Build historical category outcome claims on the same request/branch nodes. */
export function buildReviewProvenance({ workflow, sample, existingNodes } = {}) {
  if (!workflow) return { nodes: [], claims: [], identity: undefined };
  const reviewed = reviewSample(sample);
  const refs = referenceNodes(workflow);
  const subject = refs.requestNode?.id ?? refs.branchNode?.id ?? refs.conversationNode.id;
  const claims = [];
  addReferenceClaims(workflow, refs, existingNodes, claims);
  claims.push({
    subject,
    predicate: `review_${reviewed.aspect}`,
    object: reviewed.outcome,
    relation: false,
    status: "historical",
    // This is a bounded category observation from the review workflow, not a
    // source quote, acceptance decision or correctness certification.
    confidence: 0.8,
  });
  return {
    nodes: refs.nodes,
    claims,
    identity: workflowIdentity(workflow),
    aspect: reviewed.aspect,
    outcome: reviewed.outcome,
    references: refs,
  };
}

export { REVIEW_ASPECTS, REVIEW_OUTCOMES };
