import { describe, expect, it, vi } from "vitest";
import { TauriMessageReader } from "./transport";

describe("TauriMessageReader", () => {
  it("decodes complete JSON-RPC messages delivered by the native channel", () => {
    const reader = new TauriMessageReader();
    const callback = vi.fn();
    reader.listen(callback);
    reader.accept({
      type: "message",
      message: JSON.stringify({ jsonrpc: "2.0", method: "window/logMessage", params: {} }),
    });
    expect(callback).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: {},
    });
  });

  it("reports malformed channel payloads without invoking the connection", () => {
    const reader = new TauriMessageReader();
    const callback = vi.fn();
    const errors: Error[] = [];
    reader.listen(callback);
    reader.onError((error) => errors.push(error));
    reader.accept({ type: "message", message: "not-json" });
    expect(callback).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });
});
