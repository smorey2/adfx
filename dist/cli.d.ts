interface Args {
    _: string[];
    flags: Record<string, string[]>;
}
export declare function parseArgs(argv: string[]): Args;
export declare function pageIdOf(s: string): string;
export declare function main(argv?: string[]): Promise<number>;
export declare function boardIdOf(s: string): string;
export declare function run(): void;
export {};
