import { describe, expect, it } from "vitest";
import { interpretScan, isPairingCode } from "./pairingCode";

const code = "4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a88";
const origin = "https://desk.tail1234.ts.net";

describe("interpretScan", () => {
  it("pairs in place when the QR points at the relay we're already talking to", () => {
    expect(interpretScan(`${origin}/?code=${code}`, origin)).toEqual({ kind: "code", code });
  });

  it("redirects rather than pairing against the wrong desktop", () => {
    const other = `https://laptop.tail9999.ts.net/?code=${code}`;
    expect(interpretScan(other, origin)).toEqual({ kind: "redirect", url: other });
  });

  it("accepts a bare code, so a typed or pasted one takes the same path", () => {
    expect(interpretScan(`  ${code.toUpperCase()}  `, origin)).toEqual({
      kind: "code",
      code: code.toUpperCase(),
    });
  });

  it("rejects any other QR instead of sending junk to the relay", () => {
    for (const junk of [
      "https://example.com/",
      `${origin}/?code=not-a-code`,
      "WIFI:S=cafe;T=WPA;P=hunter2;;",
      "",
      "   ",
      code.slice(0, 20),
    ]) {
      expect(interpretScan(junk, origin)).toEqual({ kind: "unrecognized" });
    }
  });
});

describe("isPairingCode", () => {
  it("matches the relay's 32-hex-character code format", () => {
    expect(isPairingCode(code)).toBe(true);
    expect(isPairingCode(`${code}0`)).toBe(false);
    expect(isPairingCode("zzzz2b1a9e8d7c6b5a4f3e2d1c0b9a88")).toBe(false);
  });
});
