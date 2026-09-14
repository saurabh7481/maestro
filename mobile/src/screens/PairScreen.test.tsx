import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayClient = {
  exchangePairingCode: vi.fn(),
  whoAmI: vi.fn(),
};
const cameraAvailable = vi.fn(() => true);

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  relayClient,
}));
vi.mock("../design/camera", () => ({ cameraAvailable: () => cameraAvailable() }));

/** The real scanner needs a camera, a canvas and a video decode loop —
 * none of which jsdom has. What matters here is how `PairScreen` wires the
 * two pairing paths together, so the scanner is stubbed down to "is it
 * mounted (i.e. is the camera open), and what happens when it sees a
 * code". Decoding itself is covered by `api/pairingCode.test.ts`. */
vi.mock("../components/QrScanner", () => ({
  QrScanner: ({ onScan }: { onScan: (text: string) => void }) => (
    <button type="button" onClick={() => onScan(`${window.location.origin}/?code=${CODE}`)}>
      stub-camera
    </button>
  ),
}));

const CODE = "4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a88";

const { PairScreen } = await import("./PairScreen");
const { useAuthStore } = await import("../state/authStore");

describe("PairScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cameraAvailable.mockReturnValue(true);
    localStorage.clear();
    useAuthStore.setState({ status: "unauthenticated", pairing: false, pairError: null });
    relayClient.exchangePairingCode.mockResolvedValue({ deviceId: "d1", token: "t1" });
    relayClient.whoAmI.mockResolvedValue({ deviceId: "d1", accessLevel: "write" });
  });

  it("offers both ways to connect, leading with scanning", () => {
    render(<PairScreen />);

    expect(screen.getByText("Scan QR code").closest("button")?.dataset.selected).toBe("true");
    expect(screen.getByText("Enter code")).toBeTruthy();
  });

  it("does not open the camera until asked, so landing here prompts nobody", () => {
    render(<PairScreen />);

    expect(screen.queryByText("stub-camera")).toBeNull();
    fireEvent.click(screen.getByText("Open camera"));
    expect(screen.getByText("stub-camera")).toBeTruthy();
  });

  it("pairs from a scanned code without any typing", async () => {
    render(<PairScreen />);
    fireEvent.click(screen.getByText("Open camera"));

    fireEvent.click(screen.getByText("stub-camera"));
    await vi.waitFor(() =>
      expect(relayClient.exchangePairingCode).toHaveBeenCalledWith(CODE, expect.any(String)),
    );
    // The camera is released as soon as a code is in hand.
    expect(screen.queryByText("stub-camera")).toBeNull();
  });

  it("still pairs from a typed code", async () => {
    render(<PairScreen />);
    fireEvent.click(screen.getByText("Enter code"));

    fireEvent.change(screen.getByPlaceholderText(/^0+$/), { target: { value: CODE } });
    fireEvent.change(screen.getByDisplayValue(/browser|iPhone|iPad|Android|Mac|Windows/), {
      target: { value: "Work phone" },
    });
    fireEvent.click(screen.getByText("Pair device"));

    await vi.waitFor(() =>
      expect(relayClient.exchangePairingCode).toHaveBeenCalledWith(CODE, "Work phone"),
    );
  });

  it("falls back to manual entry where no camera can be opened", () => {
    cameraAvailable.mockReturnValue(false);
    render(<PairScreen />);

    expect(screen.getByText("Enter code").closest("button")?.dataset.selected).toBe("true");
    expect(screen.getByText("Pair device")).toBeTruthy();
  });

  it("shuts the camera off when switching to manual entry", () => {
    render(<PairScreen />);
    fireEvent.click(screen.getByText("Open camera"));
    expect(screen.getByText("stub-camera")).toBeTruthy();

    fireEvent.click(screen.getByText("Enter code"));
    fireEvent.click(screen.getByText("Scan QR code"));
    expect(screen.queryByText("stub-camera")).toBeNull();
  });
});
