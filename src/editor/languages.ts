const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  rs: "rust",
  py: "python",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  rb: "ruby",
  go: "go",
  toml: "ini",
  vue: "html",
};

// `.env`, `.env.local`, `.env.production`, etc. have no real extension to
// look up by (they're a dotfile with an optional dotted suffix, not a
// `name.ext`), and Monaco ships no dedicated "dotenv" grammar. Its bundled
// "ini" grammar — `KEY=value` lines, `#` comments — is the same
// approximation `toml` below settles for, and reads close enough to env
// files' actual syntax to be worth it over no highlighting at all.
const ENV_FILENAME = /^\.env(\..+)?$/i;

export function languageForPath(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const base = slash === -1 ? relPath : relPath.slice(slash + 1);
  if (ENV_FILENAME.test(base)) return "ini";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return EXTENSION_LANGUAGE[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}
