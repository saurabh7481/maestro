import {
  FileArchive,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJs,
  FileLock,
  FileMd,
  FilePdf,
  FilePy,
  FileRs,
  FileSql,
  FileText,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileVue,
  FileXls,
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
  js: { icon: FileJs, color: "var(--yellow)" },
  mjs: { icon: FileJs, color: "var(--yellow)" },
  cjs: { icon: FileJs, color: "var(--yellow)" },
  jsx: { icon: FileTsx, color: "var(--yellow)" },
  rs: { icon: FileRs, color: "var(--orange)" },
  vue: { icon: FileVue, color: "var(--green)" },
  css: { icon: FileCss, color: "var(--accent-2)" },
  scss: { icon: FileCss, color: "var(--purple)" },
  less: { icon: FileCss, color: "var(--purple)" },
  html: { icon: FileHtml, color: "var(--orange)" },
  htm: { icon: FileHtml, color: "var(--orange)" },
  sql: { icon: FileSql, color: "var(--cyan)" },
  md: { icon: FileMd, color: "var(--accent-2)" },
  mdx: { icon: FileMd, color: "var(--accent-2)" },
  json: { icon: FileCode, color: "var(--yellow)" },
  jsonc: { icon: FileCode, color: "var(--yellow)" },
  toml: { icon: FileIni, color: "var(--text-mute)" },
  yaml: { icon: FileCode, color: "var(--text-mute)" },
  yml: { icon: FileCode, color: "var(--text-mute)" },
  ini: { icon: FileIni, color: "var(--text-mute)" },
  conf: { icon: FileIni, color: "var(--text-mute)" },
  env: { icon: FileIni, color: "var(--text-mute)" },
  py: { icon: FilePy, color: "var(--blue)" },
  go: { icon: FileCode, color: "var(--cyan)" },
  rb: { icon: FileCode, color: "var(--red)" },
  php: { icon: FileCode, color: "var(--purple)" },
  java: { icon: FileCode, color: "var(--orange)" },
  kt: { icon: FileCode, color: "var(--purple)" },
  swift: { icon: FileCode, color: "var(--orange)" },
  c: { icon: FileC, color: "var(--blue)" },
  h: { icon: FileC, color: "var(--blue)" },
  cpp: { icon: FileCpp, color: "var(--blue)" },
  cc: { icon: FileCpp, color: "var(--blue)" },
  hpp: { icon: FileCpp, color: "var(--blue)" },
  cs: { icon: FileCSharp, color: "var(--green)" },
  sh: { icon: FileCode, color: "var(--green)" },
  bash: { icon: FileCode, color: "var(--green)" },
  zsh: { icon: FileCode, color: "var(--green)" },
  txt: { icon: FileTxt, color: "var(--text-mute)" },
  csv: { icon: FileCsv, color: "var(--green)" },
  pdf: { icon: FilePdf, color: "var(--red)" },
  doc: { icon: FileDoc, color: "var(--blue)" },
  docx: { icon: FileDoc, color: "var(--blue)" },
  xls: { icon: FileXls, color: "var(--green)" },
  xlsx: { icon: FileXls, color: "var(--green)" },
  png: { icon: FileImage, color: "var(--purple)" },
  jpg: { icon: FileImage, color: "var(--purple)" },
  jpeg: { icon: FileImage, color: "var(--purple)" },
  gif: { icon: FileImage, color: "var(--purple)" },
  webp: { icon: FileImage, color: "var(--purple)" },
  svg: { icon: FileImage, color: "var(--purple)" },
  ico: { icon: FileImage, color: "var(--purple)" },
  mp3: { icon: FileAudio, color: "var(--cyan)" },
  wav: { icon: FileAudio, color: "var(--cyan)" },
  mp4: { icon: FileVideo, color: "var(--cyan)" },
  mov: { icon: FileVideo, color: "var(--cyan)" },
  zip: { icon: FileArchive, color: "var(--text-mute)" },
  tar: { icon: FileArchive, color: "var(--text-mute)" },
  gz: { icon: FileArchive, color: "var(--text-mute)" },
  lock: { icon: FileLock, color: "var(--text-mute)" },
};

const DEFAULT_ICON: FileIconSpec = { icon: FileText, color: "var(--text-mute)" };

/** Filenames without a meaningful extension (or where the extension alone
 * is ambiguous, e.g. "*.lock") that still have a well-known type. Checked
 * before the extension table so e.g. `Dockerfile` and `package-lock.json`
 * get a more specific icon than their extension (or lack of one) implies. */
const BY_FULL_NAME: Record<string, FileIconSpec> = {
  dockerfile: { icon: FileCode, color: "var(--cyan)" },
  makefile: { icon: FileCode, color: "var(--text-mute)" },
  "package-lock.json": { icon: FileLock, color: "var(--text-mute)" },
  "yarn.lock": { icon: FileLock, color: "var(--text-mute)" },
  "pnpm-lock.yaml": { icon: FileLock, color: "var(--text-mute)" },
  "cargo.lock": { icon: FileLock, color: "var(--text-mute)" },
  ".gitignore": { icon: FileIni, color: "var(--text-mute)" },
  ".env": { icon: FileIni, color: "var(--text-mute)" },
};

export function iconForFile(name: string): FileIconSpec {
  const lower = name.toLowerCase();
  const byName = BY_FULL_NAME[lower];
  if (byName) return byName;

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_ICON;
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? DEFAULT_ICON;
}
