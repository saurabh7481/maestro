import { useEffect, useState } from "react";
import { relayClient } from "../api/client";
import type { AgentCapabilities, AgentKind, ModelOption } from "../api/types";

/** Model options and capabilities are static per `AgentKind` for the
 * lifetime of the page (they depend on which CLI is installed, not on any
 * particular run), so a plain module-level cache is enough — no need for
 * the WS-driven reactivity `agentStore.ts` has. */
const modelsCache = new Map<AgentKind, ModelOption[]>();
const capabilitiesCache = new Map<AgentKind, AgentCapabilities>();

/** What the composer assumes before a kind's real capabilities have
 * loaded — the least-capable shape, so nothing offers an affordance that
 * then turns out not to work (mirrors the desktop's
 * `CONSERVATIVE_CAPABILITIES`). */
const CONSERVATIVE_CAPABILITIES: AgentCapabilities = {
  manualGate: "externalConfig",
  planMode: false,
  separateOptionFlags: true,
  effortLabel: "Effort",
};

export function useAgentModels(kind: AgentKind | null): ModelOption[] {
  const [trackedKind, setTrackedKind] = useState(kind);
  const [models, setModels] = useState<ModelOption[]>(() =>
    kind ? (modelsCache.get(kind) ?? []) : [],
  );

  // Adjusting state during render (same pattern as
  // `ProcessingCard.tsx`) rather than in an effect: a cache hit needs no
  // network round trip, so reflecting it belongs in the render that
  // noticed `kind` changed, not in a follow-up effect commit.
  if (kind !== trackedKind) {
    setTrackedKind(kind);
    setModels(kind ? (modelsCache.get(kind) ?? []) : []);
  }

  useEffect(() => {
    if (!kind || modelsCache.has(kind)) return;
    let cancelled = false;
    relayClient
      .getAgentModels(kind)
      .then((list) => {
        modelsCache.set(kind, list);
        if (!cancelled) setModels(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return models;
}

export function useAgentCapabilities(kind: AgentKind | null): AgentCapabilities {
  const [trackedKind, setTrackedKind] = useState(kind);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(
    () => (kind && capabilitiesCache.get(kind)) || CONSERVATIVE_CAPABILITIES,
  );

  if (kind !== trackedKind) {
    setTrackedKind(kind);
    setCapabilities((kind && capabilitiesCache.get(kind)) || CONSERVATIVE_CAPABILITIES);
  }

  useEffect(() => {
    if (!kind || capabilitiesCache.has(kind)) return;
    let cancelled = false;
    relayClient
      .getAgentCapabilities(kind)
      .then((value) => {
        capabilitiesCache.set(kind, value);
        if (!cancelled) setCapabilities(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return capabilities;
}
