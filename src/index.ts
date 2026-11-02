// Library entry point: the same pieces the CLI uses.

export type { AdfDoc, AdfMark, AdfNode, Attrs } from './core/adf.ts';
export { convert, isEmptyDoc, type ConvertOptions, type ConvertResult } from './core/adoc.ts';
export { parse as parseAdoc } from './core/adoc-parse.ts';
export { buildPatch, gate, adfChanges } from './core/patch.ts';
export { parseYaml } from './core/yaml.ts';
export { resolveCredentials, saveCredentials, removeCredentials, credentialsFile } from './core/credentials.ts';
export { AtlassianClient } from './core/http.ts';
export { ConfluenceApi, FixtureApi, pageWriter, type ConfluenceReader, type PageWriter } from './confluence/api.ts';
export { parseConfluenceConfig, loadConfluenceConfig, type ConfluenceConfig, type Scope } from './confluence/config.ts';
export { pull, discover, type PullReport } from './confluence/pull.ts';
export { publish, lineDiff, type PublishResult } from './confluence/publish.ts';
export { replaceText, replaceInCells } from './confluence/replace.ts';
