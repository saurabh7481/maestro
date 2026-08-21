import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle, Plus, SignIn, X } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { opencodeApi } from "../../api/opencode";
import type {
  AuthMethod,
  AuthPrompt,
  Authorization,
  ConnectedProvider,
  ProviderOverview,
  ProviderSummary,
} from "../../types/opencode";
import { filterCatalog, visiblePrompts } from "./opencodeConnect";
import { AlertDialog, Button, Modal, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

/** How long the OAuth wait runs before declaring "didn't complete" —
 * generous enough for a slow phone-pushed GitHub login, short enough
 * that a forgotten tab doesn't poll forever (§3.4). */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POLL_MS = 1500;

/** The providers section inside OpenCode's agent card — the in-app
 * replacement for `opencode auth login` (docs/OPENCODE_INTEGRATION.md
 * §3). Mounting it acquires the sidecar for the pane's lifetime; every
 * §3.4 state lives here or in the sheets below. */
export function OpenCodeProviders() {
  const [overview, setOverview] = useState<ProviderOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<ConnectedProvider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Pane-visible consumer: hold the server for this section's lifetime.
  // The token is released on unmount; a failed acquire surfaces as the
  // error card below rather than a silent empty section.
  useEffect(() => {
    let token: number | null = null;
    let cancelled = false;
    void opencodeApi
      .acquireSidecar()
      .then((acquired) => {
        if (cancelled) {
          void opencodeApi.releaseSidecar(acquired);
          return;
        }
        token = acquired;
      })
      .catch((e) => setLoadError(String(e)));
    return () => {
      cancelled = true;
      if (token !== null) void opencodeApi.releaseSidecar(token);
    };
  }, []);

  const refresh = useCallback(async (force = false) => {
    setLoadError(null);
    try {
      setOverview(await opencodeApi.listProviders(force));
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  // Not just `void refresh()` here: routing the initial load through the
  // shared `refresh` callback reads, to the effect linter, as an effect
  // body that (transitively) sets state synchronously — even though the
  // actual `setOverview`/`setLoadError` calls are deferred past an
  // `await`. Inlined and `cancelled`-guarded instead, the same shape
  // every other mount-time fetch in this app already uses.
  useEffect(() => {
    let cancelled = false;
    // No `setLoadError(null)` here — this is the mount effect (empty deps,
    // runs once), and `loadError` already initializes to `null`; nothing
    // to clear yet.
    opencodeApi
      .listProviders(false)
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function disconnect(provider: ConnectedProvider) {
    setBusyId(provider.id);
    try {
      await opencodeApi.disconnect(provider.id);
      await refresh(true);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setBusyId(null);
      setDisconnecting(null);
    }
  }

  return (
    <div className={styles.providerSection}>
      <div className={styles.providerSectionLabel}>Providers</div>
      {!overview && !loadError && <div className={styles.agentDetail}>Starting OpenCode…</div>}
      {loadError && (
        <>
          <div className={styles.agentDetail}>{loadError}</div>
          <Button variant="secondary" onClick={() => void refresh(true)}>
            Retry
          </Button>
        </>
      )}
      {overview && (
        <>
          {overview.connected.length === 0 && (
            <div className={styles.agentDetail}>
              No providers connected yet. Connect one to use OpenCode — credentials are stored by
              opencode itself, not Maestro.
            </div>
          )}
          {overview.connected.map((provider) => (
            <div key={provider.id} className={styles.ocRow}>
              <span className={styles.ocRowName}>{provider.name}</span>
              <span className={styles.ocRowMeta}>
                {provider.modelCount} model{provider.modelCount === 1 ? "" : "s"}
                {provider.defaultModel ? ` · default ${provider.defaultModel}` : ""}
              </span>
              <span className={styles.ocRowSpacer} />
              <Button
                variant="ghost"
                disabled={busyId === provider.id}
                onClick={() => setDisconnecting(provider)}
              >
                Disconnect
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setCatalogOpen(true)}>
            <Plus size={14} />
            Add provider
          </Button>
        </>
      )}

      {catalogOpen && (
        <CatalogModal onClose={() => setCatalogOpen(false)} onConnected={() => refresh(true)} />
      )}

      <AlertDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.name ?? ""}?`}
        description={
          <>
            Your credentials for this provider are removed from opencode's own store
            (~/.local/share/opencode/auth.json). You can reconnect any time.
          </>
        }
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect(disconnecting!)}
        confirmDisabled={busyId !== null}
      />
    </div>
  );
}

/** The "Add provider" modal: searchable catalog, rows showing how each
 * provider authenticates before you commit to it (§3.2), then the connect
 * sheet for whichever row was picked. One modal shell throughout — the
 * sheet swaps in as the content, title included. */
function CatalogModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<ProviderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<ProviderSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!connecting) inputRef.current?.focus();
  }, [connecting]);
  useEffect(() => {
    let cancelled = false;
    opencodeApi
      .listProviders()
      .then((result) => !cancelled && setOverview(result))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = overview ? filterCatalog(overview.available, query) : [];

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={connecting ? `Connect ${connecting.name}` : "Connect a provider"}
      width="480px"
    >
      {connecting ? (
        <ConnectSheet
          provider={connecting}
          onBack={() => setConnecting(null)}
          onClose={onClose}
          onConnected={async () => {
            setConnecting(null);
            await onConnected();
          }}
        />
      ) : (
        <>
          <TextInput
            ref={inputRef}
            placeholder="Search providers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {error && <div className={styles.agentDetail}>{error}</div>}
          {!error && !overview && <div className={styles.agentDetail}>Loading catalog…</div>}
          {overview && groups.length === 0 && (
            <div className={styles.agentDetail}>
              No provider matches &ldquo;{query}&rdquo;.{" "}
              <button
                type="button"
                className={styles.providerDocsLink}
                onClick={() => setQuery("")}
              >
                Clear search
              </button>
            </div>
          )}
          <div className={styles.ocCatalogList} role="listbox">
            {groups.flatMap((group) =>
              group.providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className={styles.ocCatalogRow}
                  onClick={() => setConnecting(provider)}
                >
                  <span className={styles.ocRowName}>{provider.name}</span>
                  <span className={styles.ocRowSpacer} />
                  <span className={styles.ocRowMeta}>{provider.id}</span>
                </button>
              )),
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** The connect flow for one provider, driven entirely by its own declared
 * methods and prompts (§3.3). API-key methods are one masked field; OAuth
 * methods render their conditional prompts, then hand off to the browser
 * and poll until the provider turns up connected. Shell-less: it renders
 * inside CatalogModal's single modal. */
function ConnectSheet({
  provider,
  onBack,
  onClose,
  onConnected,
}: {
  provider: ProviderSummary;
  onBack: () => void;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const [methods, setMethods] = useState<AuthMethod[] | null>(null);
  const [methodIndex, setMethodIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    opencodeApi
      .providerAuthMethods(provider.id)
      .then((result) => {
        if (cancelled) return;
        setMethods(result);
        // A single method connects directly; several show the picker.
        if (result.length === 1) setMethodIndex(result[0].index);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  if (error) {
    return (
      <>
        <div className={styles.agentDetail}>{error}</div>
        <SheetActions onCancel={onClose} />
      </>
    );
  }
  if (!methods) {
    return <div className={styles.agentDetail}>Loading sign-in options…</div>;
  }
  if (methods.length === 0) {
    return (
      <>
        <div className={styles.agentDetail}>
          This provider exposes no sign-in methods — it may need configuration in your opencode.json
          instead.
        </div>
        <SheetActions onCancel={onClose} />
      </>
    );
  }

  const method = methodIndex !== null ? methods.find((m) => m.index === methodIndex) : undefined;
  if (!method) {
    return <MethodPicker methods={methods} onPick={setMethodIndex} />;
  }

  const back = methods.length > 1 ? onBack : undefined;
  if (method.kind === "oauth") {
    return (
      <OAuthFlow
        provider={provider}
        method={method}
        onBack={back}
        onClose={onClose}
        onConnected={onConnected}
      />
    );
  }
  return (
    <ApiKeyFlow
      provider={provider}
      methodLabel={method.label}
      onBack={back}
      onClose={onClose}
      onConnected={onConnected}
    />
  );
}

function MethodPicker({
  methods,
  onPick,
}: {
  methods: AuthMethod[];
  onPick: (index: number) => void;
}) {
  return (
    <div className={styles.ocSheetField}>
      {methods.map((method) => (
        <Button key={method.index} variant="secondary" onClick={() => onPick(method.index)}>
          <SignIn size={14} />
          {method.label}
        </Button>
      ))}
    </div>
  );
}

function ApiKeyFlow({
  provider,
  methodLabel,
  onBack,
  onClose,
  onConnected,
}: {
  provider: ProviderSummary;
  methodLabel: string;
  onBack?: () => void;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await opencodeApi.connectWithKey(provider.id, key.trim());
      await onConnected();
    } catch (e) {
      // The API's own rejection message is the useful part — show it
      // verbatim next to the field rather than translated into Maestro
      // copy that would inevitably be vaguer.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void save();
      }}
    >
      <div className={styles.ocSheetField}>
        <TextInput
          label={methodLabel}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          hint="Stored by opencode, never by Maestro."
        />
        {error && <div className={styles.agentDetail}>{error}</div>}
      </div>
      <SheetActions
        onCancel={onClose}
        onBack={onBack}
        extra={
          <Button type="submit" disabled={!key.trim() || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        }
      />
    </form>
  );
}

function OAuthFlow({
  provider,
  method,
  onBack,
  onClose,
  onConnected,
}: {
  provider: ProviderSummary;
  method: AuthMethod;
  onBack?: () => void;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const prompts = method.prompts;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const shown = visiblePrompts(prompts, answers);
  const missingRequired = shown.some((prompt) => !answers[prompt.key]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const inputs = shown.map(
        (prompt) => [prompt.key, answers[prompt.key] ?? ""] as [string, string],
      );
      const result = await opencodeApi.beginOauth(provider.id, method.index, inputs);
      setAuthorization(result);
      if (result.url) void openUrl(result.url);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  // Completion polling starts only once the flow has been started, and
  // stops on success, timeout, or unmount. A transient poll failure
  // (server restarting under us) shouldn't abort the wait — the timeout
  // is the backstop.
  useEffect(() => {
    if (!authorization) return;
    const deadline = Date.now() + OAUTH_TIMEOUT_MS;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          if (await opencodeApi.oauthStatus(provider.id)) {
            window.clearInterval(timer);
            await onConnected();
          } else if (Date.now() > deadline) {
            window.clearInterval(timer);
            setTimedOut(true);
          }
        } catch {
          /* keep waiting */
        }
      })();
    }, OAUTH_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorization, provider.id]);

  if (authorization) {
    return (
      <>
        <div className={styles.agentDetail}>
          {authorization.method === "code"
            ? `Complete the login in your browser using the code shown there. ${authorization.instructions}`
            : "Complete the login in the browser window we opened."}
        </div>
        {timedOut ? (
          <>
            <div className={styles.agentDetail}>
              Didn't complete in time — try again when you're ready.
            </div>
            <SheetActions
              onCancel={onClose}
              extra={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTimedOut(false);
                    setAuthorization(null);
                  }}
                >
                  Try again
                </Button>
              }
            />
          </>
        ) : (
          <>
            <div className={styles.agentDetail}>
              <CheckCircle size={14} style={{ verticalAlign: "-2px", opacity: 0.6 }} /> Waiting…
            </div>
            <SheetActions
              onCancel={onClose}
              extra={
                authorization.url ? (
                  <Button variant="secondary" onClick={() => void openUrl(authorization.url)}>
                    Open browser again
                  </Button>
                ) : undefined
              }
            />
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className={styles.agentDetail}>{method.label}</div>
      {shown.map((prompt) => (
        <PromptField
          key={prompt.key}
          prompt={prompt}
          value={answers[prompt.key] ?? ""}
          onChange={(next) => setAnswers((current) => ({ ...current, [prompt.key]: next }))}
        />
      ))}
      {error && <div className={styles.agentDetail}>{error}</div>}
      <SheetActions
        onCancel={onClose}
        onBack={onBack}
        extra={
          <Button disabled={starting || missingRequired} onClick={() => void start()}>
            {starting ? "Starting…" : "Continue"}
          </Button>
        }
      />
    </>
  );
}

/** One declarative prompt rendered generically — select or text, with
 * the provider's own labels verbatim (§3.3's copy rule). */
function PromptField({
  prompt,
  value,
  onChange,
}: {
  prompt: AuthPrompt;
  value: string;
  onChange: (next: string) => void;
}) {
  if (prompt.kind === "select") {
    return (
      <div className={styles.ocSheetField}>
        <span className={styles.chipsLabel}>{prompt.message}</span>
        <div className={styles.chips}>
          {prompt.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={styles.chip}
              data-active={value === option.value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {option.hint ? ` — ${option.hint}` : ""}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={styles.ocSheetField}>
      <TextInput
        label={prompt.message}
        placeholder={prompt.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function SheetActions({
  onCancel,
  onBack,
  extra,
}: {
  onCancel: () => void;
  onBack?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div
      className={styles.agentActions}
      style={{ justifyContent: "flex-end", marginTop: "var(--space-3)" }}
    >
      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      <Button variant="ghost" onClick={onCancel}>
        <X size={14} />
        Cancel
      </Button>
      {extra}
    </div>
  );
}
