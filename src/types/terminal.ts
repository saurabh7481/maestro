/** Mirrors `src-tauri/src/terminal.rs`'s `PtyEvent`. `data` is base64 —
 * PTY output is arbitrary bytes and can split a multi-byte UTF-8
 * sequence across reads, so this is the only safe wire representation. */
export type PtyEvent = { type: "data"; base64: string } | { type: "exit"; code: number | null };
