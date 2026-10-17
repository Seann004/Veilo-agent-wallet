export declare const REPO_ROOT: string;
export declare function toolchainMode(): "docker" | "native";
export declare function isNativeToolchain(): boolean;
export declare function toolchainWorkspace(): string;
export declare function toolchainPins(): { rust: string; agave: string; anchor: string; circom: string; platformTools: string };
export declare function nativeToolchainProblems(): string[];
export declare function assertNativeToolchain(): void;
export declare function nativeToolchainEnv(): NodeJS.ProcessEnv;
