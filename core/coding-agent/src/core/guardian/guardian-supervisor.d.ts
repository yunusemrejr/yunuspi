import type { AgentEvent } from "@yunuspi/agent-core";
export declare const GUARDIAN_REQUEST_META: unique symbol;
export interface GuardianRequestMetadata {
    requestId: string;
    turnId: string;
    sessionId: string;
    processId: string;
    guardianOwnerId?: string;
}
export interface GuardianInterventionTarget {
    kind: "session" | "subagent";
    sessionId?: string;
    runId?: string;
    agentId?: string;
    childIndex?: number;
}
export interface GuardianInterventionDetail {
    version: 1;
    kind: "repeated-identical-failure" | "verified-constraint-drift";
    category: "repeated-identical-failure" | "verified-constraint-drift";
    requestId: string;
    taskId: string;
    turnId: string;
    sessionId: string;
    processId: string;
    guardianInstanceId: string;
    agentId: string;
    createdAt: number;
    dedupeKey: string;
    target: GuardianInterventionTarget;
    confidenceScore?: number;
    confidenceThreshold?: number;
    modelVersion?: number;
    observedSignals?: { fileTypes: string[]; skills: string[]; toolCalls: number };
    evidence: Array<{ kind: string; id: string; hash: string }>;
}
export interface GuardianChildRelay { id: string; channelDir: string; expiresAt: number }
export interface GuardianSupervisorOptions {
    sessionId: string;
    sessionOwner?: object;
    processId?: string;
    cwd?: string;
    emit?: (event: { type: "guardian_intervention"; content: string; detail: GuardianInterventionDetail; child: boolean }) => void | Promise<void>;
    /** Display-only receipt after an owned tool result; successful WASM calls are counted separately from observations. */
    observe?: (data: { count: number; evaluations: number; similarityEvaluations: number; promptCoverage: "complete" | "bounded-out"; decision: "lazy" | "initializing" | "ready" | "quarantined"; outcome: "observed" | "evaluated" }) => void | Promise<void>;
    clock?: () => number;
    childRelay?: (reason: "guardian_intervention" | "intelligence_used", message: string) => GuardianChildRelay | undefined;
    awaitParentVisibility?: (relay: GuardianChildRelay, options?: { timeoutMs?: number; stillCurrent?: () => boolean }) => boolean | Promise<boolean>;
}
export declare function tagGuardianRequestMessage<T extends object>(message: T, metadata: GuardianRequestMetadata): T;
export declare function guardianRequestMessages(messages: unknown[]): Array<{ requestId: string; turnId: string; messageIndex: number }>;
export declare function relayIntelligenceUsageFromChild(input: { name: "JEV" | "Needle3" | "FuzzyML" | "Kompress" | "Smol" | "retrieval" | "Neural ranker" | "Intent classifier" | "WASM source check" | "Deterministic selection"; sessionId: string; ownerId: string; stage?: "result" | "cached" | "applied" | "delivered" | "returned" | "skipped"; source?: "remote" | "local" | "wasm"; count?: number; durationMs?: number; savedChars?: number }): boolean;
export declare function guardianOwnerForSession(sessionId: string, sessionOwner?: object): string | undefined;
export declare class GuardianSupervisor {
    constructor(options: GuardianSupervisorOptions);
    readonly enabled: boolean;
    readonly debug: boolean;
    readonly ownerId: string;
    beginRequest(input: { requestId: string; turnId?: string; sessionId?: string; source?: "interactive" | "rpc" | "extension"; originalText: string }): GuardianRequestMetadata | undefined;
    noteInput(input: { requestId: string; turnId?: string; sessionId?: string; source?: "interactive" | "rpc" | "extension"; originalText: string }): GuardianRequestMetadata | undefined;
    acceptRequest(requestId: string): boolean;
    cancelRequest(requestId: string): boolean;
    observePromptAnalysis(event: unknown): boolean;
    /** Count addressed peer communication without accepting it as task authority. */
    observePeerMessage(event: unknown): boolean;
    observeAgentEvent(event: AgentEvent): Promise<void>;
    analyzeToolActivity(activity: { taskId?: string; toolName: string; args: unknown; toolCallId?: string; succeeded: boolean; observedAt?: number }): Promise<boolean>;
    handleCommand(text: string): { command: string; enabled: boolean; debug: boolean; stats: Record<string, number>; kernel: string; taskCount: number; activeTaskId?: string; guardianInstanceId?: string; debugInfo?: { relation?: string; analysisConfidence?: number; verifiedConstraints: number; observedSignals?: { fileTypes: string[]; skills: string[]; toolCalls: number }; recentDecisions: unknown[] } } | undefined;
    quarantine(error: unknown): void;
    dispose(): void;
}
