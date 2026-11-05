export type YamlValue = string | null | YamlValue[] | {
    [key: string]: YamlValue;
};
export declare class YamlError extends Error {
}
export declare function parseYaml(source: string, file?: string): YamlValue;
