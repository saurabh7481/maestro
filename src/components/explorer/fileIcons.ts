import {
  FileCode,
  FileCss,
  FileHtml,
  FileMd,
  FileRs,
  FileSql,
  FileText,
  FileTs,
  FileTsx,
  FileVue,
  type Icon,
} from "@phosphor-icons/react";

interface FileIconSpec {
  icon: Icon;
  color: string;
}

const BY_EXTENSION: Record<string, FileIconSpec> = {
  ts: { icon: FileTs, color: "var(--blue)" },
  mts: { icon: FileTs, color: "var(--blue)" },
  cts: { icon: FileTs, color: "var(--blue)" },
  tsx: { icon: FileTsx, color: "var(--blue)" },
  js: { icon: FileTs, color: "var(--yellow)" },
  mjs: { icon: FileTs, color: "var(--yellow)" },
  jsx: { icon: FileTsx, color: "var(--yellow)" },
  rs: { icon: FileRs, color: "var(--orange)" },
  vue: { icon: FileVue, color: "var(--green)" },
  css: { icon: FileCss, color: "var(--accent-2)" },
  scss: { icon: FileCss, color: "var(--purple)" },
  html: { icon: FileHtml, color: "var(--orange)" },
  sql: { icon: FileSql, color: "var(--cyan)" },
  md: { icon: FileMd, color: "var(--accent-2)" },
  mdx: { icon: FileMd, color: "var(--accent-2)" },
  json: { icon: FileCode, color: "var(--yellow)" },
  jsonc: { icon: FileCode, color: "var(--yellow)" },
  toml: { icon: FileCode, color: "var(--text-mute)" },
  yaml: { icon: FileCode, color: "var(--text-mute)" },
  yml: { icon: FileCode, color: "var(--text-mute)" },
};

const DEFAULT_ICON: FileIconSpec = { icon: FileText, color: "var(--text-mute)" };

export function iconForFile(name: string): FileIconSpec {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_ICON;
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? DEFAULT_ICON;
}
