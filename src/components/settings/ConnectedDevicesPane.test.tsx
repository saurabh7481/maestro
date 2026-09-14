import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives";
import type { FunnelReport, FunnelState } from "../../api/relay";

const relayApi = {
  status: vi.fn(),
  listDevices: vi.fn(),
  checkFunnel: vi.fn(),
  setEnabled: vi.fn(),
  createPairingCode: vi.fn(),
};
const openUrl = vi.fn();

vi.mock("../../api/relay", () => ({ relayApi }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn() } }));

const { ConnectedDevicesPane } = await import("./ConnectedDevicesPane");

function report(state: FunnelState, overrides: Partial<FunnelReport> = {}): FunnelReport {
  return {
    state,
    blocksEnabling: false,
    title: `title-${state}`,
    message: `message-${state}`,
    helpUrl: null,
    helpLabel: null,
    command: null,
    detail: "",
    ...overrides,
  };
}

const notInstalled = report("notInstalled", {
  blocksEnabling: true,
  title: "Tailscale isn't installed",
  message: "Remote access works over Tailscale Funnel.",
  helpUrl: "https://tailscale.com/download",
  helpLabel: "Install Tailscale",
  detail: "tailscale: No such file or directory",
});

function renderPane() {
  return render(
    <TooltipProvider>
      <ConnectedDevicesPane />
    </TooltipProvider>,
  );
}

describe("ConnectedDevicesPane — Tailscale setup guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayApi.status.mockResolvedValue({ enabled: false, port: null, hostname: null });
    relayApi.listDevices.mockResolvedValue([]);
    relayApi.checkFunnel.mockResolvedValue(report("ready"));
  });

  it("says nothing when the machine is already set up", async () => {
    renderPane();
    await vi.waitFor(() => expect(relayApi.checkFunnel).toHaveBeenCalled());
    expect(screen.queryByText("Recheck")).toBeNull();
  });

  it("names the missing step and links at its fix before the toggle is ever touched", async () => {
    relayApi.checkFunnel.mockResolvedValue(notInstalled);
    renderPane();

    await screen.findByText("Tailscale isn't installed");
    expect(screen.getByText("Remote access works over Tailscale Funnel.")).toBeTruthy();

    fireEvent.click(screen.getByText("Install Tailscale"));
    expect(openUrl).toHaveBeenCalledWith("https://tailscale.com/download");
  });

  it("refuses the toggle only where turning it on is certain to fail", async () => {
    relayApi.checkFunnel.mockResolvedValue(notInstalled);
    const { unmount } = renderPane();
    await screen.findByText("Tailscale isn't installed");
    expect(screen.getByLabelText("Enable remote access").hasAttribute("disabled")).toBe(true);
    unmount();

    // A capability-derived guess must not lock out a setup that works —
    // the guidance shows, but the user can still try.
    relayApi.checkFunnel.mockResolvedValue(
      report("funnelNotEnabled", { title: "Funnel isn't enabled for your tailnet" }),
    );
    renderPane();
    await screen.findByText("Funnel isn't enabled for your tailnet");
    expect(screen.getByLabelText("Enable remote access").hasAttribute("disabled")).toBe(false);
  });

  it("turns a failed enable into the same guidance, not a raw CLI string", async () => {
    relayApi.setEnabled.mockRejectedValue(notInstalled);
    renderPane();
    await vi.waitFor(() => expect(relayApi.checkFunnel).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Enable remote access"));

    await screen.findByText("Tailscale isn't installed");
    expect(screen.getByText("Install Tailscale")).toBeTruthy();
  });

  it("keeps the raw Tailscale output available but out of the way", async () => {
    relayApi.checkFunnel.mockResolvedValue(notInstalled);
    renderPane();
    await screen.findByText("Tailscale isn't installed");

    expect(screen.queryByText(/No such file or directory/)).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/No such file or directory/)).toBeTruthy();
  });

  it("offers the command to run where the fix is local, and rechecks on demand", async () => {
    relayApi.checkFunnel.mockResolvedValue(
      report("daemonNotRunning", {
        blocksEnabling: true,
        title: "Tailscale isn't running",
        command: "sudo systemctl start tailscaled",
      }),
    );
    renderPane();
    await screen.findByText("Tailscale isn't running");
    expect(screen.getByText("sudo systemctl start tailscaled")).toBeTruthy();

    relayApi.checkFunnel.mockResolvedValue(report("ready"));
    fireEvent.click(screen.getByText("Recheck"));
    await vi.waitFor(() => expect(screen.queryByText("Tailscale isn't running")).toBeNull());
  });
});
