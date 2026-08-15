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

export function languageForPath(relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return EXTENSION_LANGUAGE[relPath.slice(dot + 1).toLowerCase()] ?? "plaintext";
}
