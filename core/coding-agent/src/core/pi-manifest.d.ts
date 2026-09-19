export interface PiManifest {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
}
export declare function readPiManifest(packageJsonPath: string): PiManifest | null;
