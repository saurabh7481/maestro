import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, CheckCircle, Key, Warning, WarningCircle } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { agentsApi } from "../../api/agents";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import type { AiderProviderStatus, ProviderField } from "../../types/agent";
import { Button, Switch, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

/** What the picker will be able to offer once this provider is on.
 *
 * Worth saying out loud because it differs sharply between providers —
 * OpenRouter browses hundreds of models, Azure has none to browse because
 * the "model" is a deployment the user named. A user who doesn't know that
 * reads an empty picker as a bug. */
function catalogHint(provider: AiderProviderStatus): string {
  switch (provider.catalog.kind) {
    case "publicHttp":
      return "Models are listed live from OpenRouter's public catalog.";
    case "localHttp":
      return "Models are listed from your running server.";
    case "litellmDb":
      return "Models come from Aider's bundled model table.";
    case "manual":
      return provider.catalog.hint;
  }
}

/** One credential field, rendered from its declaration rather than from
 * any knowledge of which provider it belongs to. */
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ProviderField;
  value: string;
  onChange: (next: string) => void;
}) {
  const isSecret = field.kind === "secret";
  // A stored secret is never sent back to the UI, so an empty box next to
  // "Saved" means "unchanged", not "empty". Saying so prevents the natural
  // reading that the key was lost.
  const hint = isSecret
    ? field.hasSecret
      ? "Saved. Leave blank to keep it, or paste a new one to replace it."
      : field.required
        ? "Required."
        : "Optional."
    : undefined;

  return (
    <TextInput
      label={field.label}
      hint={hint}
      type={isSecret ? "password" : "text"}
      autoComplete="off"
      spellCheck={false}
      placeholder={field.placeholder ?? (isSecret && field.hasSecret ? "••••••••" : undefined)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ProviderCard({
  provider,
  allProviders,
  onChanged,
  canStoreSecrets,
}: {
  provider: AiderProviderStatus;
  allProviders: AiderProviderStatus[];
  onChanged: () => Promise<void>;
  canStoreSecrets: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(provider.enabled);

  // Any provider sharing an environment variable with this one, that is
  // already on. Enabling both would silently cross their endpoints, so the
  // backend refuses — this surfaces that before the user tries.
  const blockedBy = provider.conflictsWith
    .map((id) => allProviders.find((p) => p.id === id))
    .filter((p): p is AiderProviderStatus => !!p && p.enabled);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await agentsApi.saveAiderProvider(provider.id, draft, enabled);
      setDraft({});
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await agentsApi.forgetAiderProvider(provider.id);
      setDraft({});
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const status = provider.enabled
    ? provider.configured
      ? { tone: "ready" as const, Icon: CheckCircle, label: "Active" }
      : { tone: "warn" as const, Icon: WarningCircle, label: "Incomplete" }
    : provider.configured
      ? { tone: "checking" as const, Icon: CheckCircle, label: "Saved, off" }
      : null;

  const consoleUrl = provider.consoleUrl ?? "";

  return (
    <div className={styles.agentCard}>
      <div className={styles.agentCardHeader}>
        <button
          type="button"
          className={styles.providerToggle}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className={styles.agentCardName}>{provider.displayName}</span>
          {provider.note && <span className={styles.agentCardVersion}>{provider.note}</span>}
        </button>
        <div className={styles.providerHeaderRight}>
          {status && (
            <span className={styles.statusPill} data-tone={status.tone}>
              <status.Icon size={12} weight="fill" />
              {status.label}
            </span>
          )}
          <Switch
            checked={provider.enabled}
            disabled={busy || blockedBy.length > 0 || (!provider.configured && !expanded)}
            onCheckedChange={(next) => void save(next)}
            label={`Enable ${provider.displayName}`}
          />
        </div>
      </div>

      {blockedBy.length > 0 && (
        <div className={styles.agentDetail} data-tone="warn">
          <Warning size={12} weight="fill" /> Shares environment variables with{" "}
          {blockedBy.map((p) => p.displayName).join(", ")}, so only one can be on at a time.
        </div>
      )}

      {expanded && (
        <>
          <div className={styles.providerFields}>
            {provider.fields.map((field) => (
              <FieldInput
                key={field.envVar}
                field={field}
                value={draft[field.envVar] ?? (field.kind === "plain" ? (field.value ?? "") : "")}
                onChange={(next) => setDraft((d) => ({ ...d, [field.envVar]: next }))}
              />
            ))}
          </div>

          <div className={styles.agentDetail}>
            {catalogHint(provider)} Model ids are prefixed <code>{provider.modelPrefix}</code>.
          </div>

          {error && (
            <div className={styles.agentDetail} data-tone="warn">
              {error}
            </div>
          )}

          <div className={styles.agentActions}>
            <Button
              variant="secondary"
              disabled={busy || !canStoreSecrets}
              onClick={() => void save(provider.enabled)}
            >
              Save
            </Button>
            {provider.configured && (
              <Button variant="ghost" disabled={busy} onClick={() => void forget()}>
                Forget
              </Button>
            )}
            {/* The action that was missing: somewhere to actually get a
                key. `docsUrl` is Aider's page *about* the provider, which
                is not the same thing and is not what someone staring at an
                empty key field needs. */}
            {provider.consoleUrl && (
              <Button variant="secondary" onClick={() => void openUrl(consoleUrl)}>
                <Key size={14} />
                Get API key
              </Button>
            )}
            <button
              type="button"
              className={styles.providerDocsLink}
              onClick={() => void openUrl(provider.docsUrl)}
            >
              Setup guide <ArrowSquareOut size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Aider's LLM provider configuration, rendered *inside* Aider's card in
 * the Agents pane rather than as a section of its own.
 *
 * It belongs there because these providers are not an adjacent setting —
 * they are what makes Aider work at all. As a separate section, Aider's
 * card said "Needs provider" while the thing that fixed it lived
 * elsewhere on the page.
 *
 * The list renders entirely from what `agents/aider/providers.rs`
 * declares, so adding a provider there needs no change in this file. */
export function AiderProviders() {
  const [providers, setProviders] = useState<AiderProviderStatus[] | null>(null);
  const [keychainError, setKeychainError] = useState<string | null>(null);
  // Bumped after a save so the effect below re-reads. Reloading through a
  // dependency rather than by calling a loader directly keeps the fetch in
  // one place and lets the cleanup below cover every path.
  const [reloadNonce, setReloadNonce] = useState(0);
  const refreshAgent = useAgentAvailabilityStore((s) => s.refresh);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([agentsApi.listAiderProviders(), agentsApi.aiderKeychainStatus()]).then(
      async ([list, keychain]) => {
        if (cancelled) return;
        setProviders(list);
        setKeychainError(keychain);
        // Aider's readiness is derived from what's configured here, so
        // the cached CLI status is stale the moment a provider changes.
        await refreshAgent("aider");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, refreshAgent]);

  const load = useCallback(async () => {
    setReloadNonce((n) => n + 1);
  }, []);

  const activeCount = providers?.filter((p) => p.enabled && p.configured).length ?? 0;

  return (
    <>
      <div className={styles.providerSectionLabel}>Model providers</div>
      <p className={styles.placeholder} style={{ marginBottom: "var(--space-2)" }}>
        Aider talks to whichever provider you configure here, and the model picker offers exactly
        what these providers can serve. API keys go to your operating system&apos;s keychain, never
        to Maestro&apos;s database, and reach Aider as environment variables rather than on its
        command line.
      </p>

      {keychainError && (
        <div className={styles.agentDetail} data-tone="warn">
          <Warning size={12} weight="fill" /> No OS keychain is available, so API keys can&apos;t be
          saved here ({keychainError}). Configure providers in Aider&apos;s own{" "}
          <code>~/.aider.conf.yml</code> or a <code>.env</code> file instead — Maestro will still
          pick up whichever models those make available.
        </div>
      )}

      {providers === null ? (
        <p className={styles.placeholder}>Loading providers…</p>
      ) : (
        <>
          {activeCount === 0 && !keychainError && (
            <div className={styles.agentDetail}>
              Nothing configured yet — Aider won&apos;t appear as ready until at least one provider
              is on.
            </div>
          )}
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              allProviders={providers}
              onChanged={load}
              canStoreSecrets={!keychainError}
            />
          ))}
        </>
      )}
    </>
  );
}
