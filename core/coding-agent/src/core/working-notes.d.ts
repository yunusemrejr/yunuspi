/** A user's own notes are bounded so one pasted document cannot crowd the prompt. */
export declare const MAX_USER_NOTES_CHARS: number;
/** The built-in working notes every session starts with. */
export declare const WORKING_NOTES: string;
/** The short form a delegated child gets after its role prompt. */
export declare const DELEGATED_NOTES: string;
export interface GuideRoute {
    /** The kind of work, in the words a user would use. */
    work: string;
    /** Skill directory names whose SKILL.md covers it. */
    guides: string[];
}
export declare const GUIDE_ROUTES: GuideRoute[];
/** The guide index for the skills actually installed under `skillsDir`; empty when none are. */
export declare function guideIndex(skillsDir: string, installed?: (name: string) => boolean): string;
/**
 * The notes for this agent directory: `<agentDir>/NOTES.md` when the user keeps
 * one, else the built-in text, followed by the guide index. Read once per
 * process. `delegated` returns the short form with the same guide index.
 * `PI_WORKING_NOTES=0` returns an empty string.
 */
export declare function loadWorkingNotes(agentDir: string | undefined, env?: NodeJS.ProcessEnv, delegated?: boolean): string;
export declare function resetWorkingNotesCache(): void;
