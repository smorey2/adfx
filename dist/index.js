// Library entry point: the same pieces the CLI uses.
export { convert, isEmptyDoc } from "./core/adoc.js";
export { parse as parseAdoc } from "./core/adoc-parse.js";
export { buildPatch, gate, adfChanges } from "./core/patch.js";
export { parseYaml } from "./core/yaml.js";
export { resolveCredentials, saveCredentials, removeCredentials, credentialsFile } from "./core/credentials.js";
export { AtlassianClient } from "./core/http.js";
export { ConfluenceApi, FixtureApi, pageWriter } from "./confluence/api.js";
export { parseConfluenceConfig, loadConfluenceConfig } from "./confluence/config.js";
export { pull, discover } from "./confluence/pull.js";
export { publish, lineDiff } from "./confluence/publish.js";
export { replaceText, replaceInCells } from "./confluence/replace.js";
