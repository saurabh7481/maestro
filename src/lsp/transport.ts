import {
  AbstractMessageReader,
  AbstractMessageWriter,
  Disposable,
  type DataCallback,
  type Message,
} from "vscode-jsonrpc/browser";
import { lspApi } from "../api/lsp";
import type { LspServerKind, LspTransportEvent, RunningLspServer } from "../types/lsp";

export class TauriMessageReader extends AbstractMessageReader {
  private callback: DataCallback | null = null;

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    return Disposable.create(() => {
      if (this.callback === callback) this.callback = null;
    });
  }

  accept(event: LspTransportEvent) {
    if (event.type === "message") {
      try {
        this.callback?.(JSON.parse(event.message) as Message);
      } catch (error) {
        this.fireError(error);
      }
    } else if (event.type === "protocolError") {
      this.fireError(new Error(event.message));
      if (event.fatal) this.fireClose();
    } else if (event.type === "exited") {
      this.fireClose();
    }
  }
}

/** Batches outbound LSP traffic into one `invoke` per microtask turn.
 *
 * Every message used to be its own awaited `invoke`, so typing in an editor
 * produced one full IPC round-trip per keystroke's `textDocument/didChange`
 * — and because `vscode-jsonrpc` serializes writes, the *next* message
 * couldn't start until that round-trip came back
 * (docs/PERFORMANCE_AUDIT.md §2.5).
 *
 * Ordering is preserved: messages append to a FIFO queue and the flush
 * sends the whole queue in one call, so the server sees exactly the
 * sequence `vscode-jsonrpc` produced. `write()` resolves once the message
 * is *queued* rather than once it's been handed to the server process,
 * which is the same guarantee a socket-backed writer gives — a failed
 * flush still reaches the connection through `fireError`. */
export class TauriMessageWriter extends AbstractMessageWriter {
  private queue: string[] = [];
  private draining = false;

  constructor(
    private readonly worktreeId: string,
    private readonly kind: LspServerKind,
    private readonly running: Promise<RunningLspServer>,
  ) {
    super();
  }

  write(message: Message): Promise<void> {
    try {
      this.queue.push(JSON.stringify(message));
    } catch (error) {
      // A message that can't even be serialized is this message's problem,
      // not the connection's — report it without poisoning the queue.
      this.fireError(error, message);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.scheduleFlush(message);
    return Promise.resolve();
  }

  /** Exactly one `invoke` is in flight at a time. That is load-bearing, not
   * just tidy: concurrent `invoke`s have no ordering guarantee across the
   * IPC bridge, so letting a second batch start while the first is still
   * out could deliver a `didChange` before the `didOpen` it depends on.
   * Messages written during a flush accumulate and go out as the next
   * batch, in order, once the current one lands. */
  private scheduleFlush(cause: Message): void {
    if (this.draining) return;
    this.draining = true;
    void Promise.resolve().then(async () => {
      try {
        const server = await this.running;
        while (this.queue.length > 0) {
          const batch = this.queue;
          this.queue = [];
          await lspApi.sendMessages(this.worktreeId, this.kind, server.generation, batch);
        }
      } catch (error) {
        // The connection is the thing that failed, so anything still queued
        // for it is moot — dropped rather than retried, which would just
        // re-fail against a dead server on every subsequent write.
        this.queue = [];
        this.fireError(error, cause);
      } finally {
        this.draining = false;
      }
    });
  }

  end(): void {
    this.fireClose();
  }
}
