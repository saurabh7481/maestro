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

export class TauriMessageWriter extends AbstractMessageWriter {
  constructor(
    private readonly worktreeId: string,
    private readonly kind: LspServerKind,
    private readonly running: Promise<RunningLspServer>,
  ) {
    super();
  }

  async write(message: Message): Promise<void> {
    try {
      const server = await this.running;
      await lspApi.sendMessage(
        this.worktreeId,
        this.kind,
        server.generation,
        JSON.stringify(message),
      );
    } catch (error) {
      this.fireError(error, message);
      throw error;
    }
  }

  end(): void {
    this.fireClose();
  }
}
