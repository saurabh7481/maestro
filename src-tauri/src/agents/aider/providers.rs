//! The LLM backends Aider can be pointed at, declared as data.
//!
//! ## Why this file exists
//!
//! Every other CLI Maestro wraps owns its own auth: `claude auth login`,
//! `cursor-agent login`, `codex login`. Aider owns none — it is a client
//! for whatever provider the user has credentials for, so "is Aider ready"
//! is really "has the user configured a provider". That configuration has
//! to live somewhere, and the naive version of it is a pile of
//! `if provider == "openrouter"` branches spread across the settings UI,
//! the model picker, and the spawn path.
//!
//! Instead every provider is one `AiderProvider` literal below. A provider
//! is described by two things: the credential fields it needs (which the
//! settings UI renders generically) and how its model list is obtained
//! (which `catalog.rs` dispatches on). Adding a provider is adding a
//! literal here — no UI edit, no new command, no new match arm.
//!
//! ## Where these values come from
//!
//! Environment variable names are taken from Aider's own source rather
//! than from prose: `models.py`'s `fast_validate_environment` keymap, and
//! the per-provider pages bundled at
//! `aider/website/docs/llms/*.md` in the installed package. Model
//! prefixes are LiteLLM's routing prefixes, which is what Aider passes
//! through to `--model`. Verified against aider 0.86.2.

use serde::Serialize;

/// How a credential field is treated — the only distinction that matters
/// is whether the value is a secret, because that decides storage:
/// secrets go to the OS keychain, everything else to the `settings`
/// table. See `credentials.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    /// Masked in the UI, written to the OS keychain, never logged and
    /// never placed on a command line.
    Secret,
    /// A base URL, region, or project id. Not sensitive, so it lives in
    /// the ordinary settings table where it can be inspected.
    Plain,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    /// The environment variable Aider/LiteLLM reads this value from. This
    /// doubles as the field's stable storage key, so it must match the
    /// real variable name exactly.
    pub env_var: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
    /// A provider is only "configured" once all its required fields are
    /// filled. Optional fields cover things like Ollama's API key, which
    /// most local installs don't set.
    pub required: bool,
    pub placeholder: Option<&'static str>,
}

const fn secret(env_var: &'static str, label: &'static str) -> CredentialField {
    CredentialField {
        env_var,
        label,
        kind: FieldKind::Secret,
        required: true,
        placeholder: None,
    }
}

const fn plain(
    env_var: &'static str,
    label: &'static str,
    placeholder: &'static str,
) -> CredentialField {
    CredentialField {
        env_var,
        label,
        kind: FieldKind::Plain,
        required: true,
        placeholder: Some(placeholder),
    }
}

const fn optional_secret(env_var: &'static str, label: &'static str) -> CredentialField {
    CredentialField {
        env_var,
        label,
        kind: FieldKind::Secret,
        required: false,
        placeholder: None,
    }
}

/// How to obtain the list of models a provider can serve.
///
/// This varies more than one would hope, which is the main reason model
/// listing can't be a single code path: OpenRouter publishes a far larger
/// catalog than LiteLLM's bundled table knows about, local servers can
/// only be asked at runtime, and some providers have no enumerable list at
/// all because the "model" is a deployment the user named themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Catalog {
    /// A public HTTPS catalog that needs no credential to read. Currently
    /// only OpenRouter, whose `/api/v1/models` returns the full catalog
    /// unauthenticated — measured at 414 models against LiteLLM's bundled
    /// table's 112, which is why this can't just use `LitellmDb`.
    PublicHttp { url: &'static str },
    /// A local server's OpenAI-compatible or native model list, reached
    /// through whichever base-URL field the user filled in.
    LocalHttp {
        base_field: &'static str,
        path: &'static str,
        shape: LocalShape,
    },
    /// LiteLLM's bundled model table, queried by running
    /// `aider --list-models <prefix>`. Offline and credential-free, but
    /// only as current as the installed Aider.
    LitellmDb,
    /// No enumeration exists — the user names the model themselves,
    /// because it is an Azure deployment name or a custom endpoint's
    /// arbitrary id.
    Manual { hint: &'static str },
}

/// The two JSON shapes local model servers use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalShape {
    /// Ollama's native `/api/tags`: `{"models":[{"name":"llama3:8b"}]}`.
    OllamaTags,
    /// OpenAI-compatible `/v1/models`: `{"data":[{"id":"..."}]}`.
    OpenAiModels,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiderProvider {
    /// Stable id used in settings keys and keychain entries. Never
    /// displayed.
    pub id: &'static str,
    pub display_name: &'static str,
    /// LiteLLM routing prefix Aider expects on `--model`. Model ids from
    /// this provider's catalog are stored already carrying it.
    pub model_prefix: &'static str,
    pub docs_url: &'static str,
    /// Where the user actually obtains a credential — the provider's own
    /// key console, opened in a browser. Distinct from `docs_url`, which
    /// is Aider's page *about* the provider: sending someone to
    /// documentation when what they need is the key page is the gap that
    /// made "Needs login" a dead end. `None` for providers where no such
    /// page exists (a local server, or an arbitrary custom endpoint).
    pub console_url: Option<&'static str>,
    pub fields: &'static [CredentialField],
    pub catalog: Catalog,
    /// Shown under the provider's name in settings — one line on what the
    /// user is signing up for, especially where the model id has a shape
    /// they must know about.
    pub note: Option<&'static str>,
}

impl AiderProvider {
    /// Every environment variable this provider would set. Used both to
    /// build the spawn environment and to detect the collisions described
    /// on `conflicts_with`.
    pub fn env_vars(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.fields.iter().map(|f| f.env_var)
    }

    /// Providers that cannot be enabled at the same time as this one,
    /// because they would write different values to the same environment
    /// variable.
    ///
    /// This is derived rather than declared so it cannot drift: three
    /// providers (OpenAI, GitHub Copilot, and generic OpenAI-compatible
    /// endpoints) all authenticate through `OPENAI_API_KEY`/
    /// `OPENAI_API_BASE`, so enabling two of them would silently point one
    /// at the other's endpoint.
    pub fn conflicts_with(&self) -> Vec<&'static str> {
        all()
            .iter()
            .filter(|other| other.id != self.id)
            .filter(|other| {
                other
                    .env_vars()
                    .any(|var| self.env_vars().any(|mine| mine == var))
            })
            .map(|other| other.id)
            .collect()
    }
}

/// **This is the list a new provider is added to.**
///
/// A `static` rather than a function body so the slice really is
/// `'static` — every field is a `&'static str` or a `Copy` enum, so the
/// whole table lives in the binary.
static PROVIDERS: &[AiderProvider] = &[
    AiderProvider {
        id: "openrouter",
        display_name: "OpenRouter",
        model_prefix: "openrouter/",
        docs_url: "https://aider.chat/docs/llms/openrouter.html",
        console_url: Some("https://openrouter.ai/keys"),
        fields: &[secret("OPENROUTER_API_KEY", "API key")],
        catalog: Catalog::PublicHttp {
            url: "https://openrouter.ai/api/v1/models",
        },
        note: Some("One key for hundreds of models across providers."),
    },
    AiderProvider {
        id: "anthropic",
        display_name: "Anthropic",
        model_prefix: "anthropic/",
        docs_url: "https://aider.chat/docs/llms/anthropic.html",
        console_url: Some("https://console.anthropic.com/settings/keys"),
        fields: &[secret("ANTHROPIC_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "openai",
        display_name: "OpenAI",
        model_prefix: "openai/",
        docs_url: "https://aider.chat/docs/llms/openai.html",
        console_url: Some("https://platform.openai.com/api-keys"),
        fields: &[secret("OPENAI_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "gemini",
        display_name: "Google Gemini",
        model_prefix: "gemini/",
        docs_url: "https://aider.chat/docs/llms/gemini.html",
        console_url: Some("https://aistudio.google.com/apikey"),
        fields: &[secret("GEMINI_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "deepseek",
        display_name: "DeepSeek",
        model_prefix: "deepseek/",
        docs_url: "https://aider.chat/docs/llms/deepseek.html",
        console_url: Some("https://platform.deepseek.com/api_keys"),
        fields: &[secret("DEEPSEEK_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "xai",
        display_name: "xAI",
        model_prefix: "xai/",
        docs_url: "https://aider.chat/docs/llms/xai.html",
        console_url: Some("https://console.x.ai"),
        fields: &[secret("XAI_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "groq",
        display_name: "Groq",
        model_prefix: "groq/",
        docs_url: "https://aider.chat/docs/llms/groq.html",
        console_url: Some("https://console.groq.com/keys"),
        fields: &[secret("GROQ_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "cohere",
        display_name: "Cohere",
        model_prefix: "cohere/",
        docs_url: "https://aider.chat/docs/llms/cohere.html",
        console_url: Some("https://dashboard.cohere.com/api-keys"),
        fields: &[secret("COHERE_API_KEY", "API key")],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "ollama",
        display_name: "Ollama",
        model_prefix: "ollama_chat/",
        docs_url: "https://aider.chat/docs/llms/ollama.html",
        console_url: None,
        fields: &[
            plain("OLLAMA_API_BASE", "Server URL", "http://127.0.0.1:11434"),
            optional_secret(
                "OLLAMA_API_KEY",
                "API key (only if your server requires one)",
            ),
        ],
        catalog: Catalog::LocalHttp {
            base_field: "OLLAMA_API_BASE",
            path: "/api/tags",
            shape: LocalShape::OllamaTags,
        },
        note: Some("Runs locally. Models are listed from your running Ollama server."),
    },
    AiderProvider {
        id: "lm-studio",
        display_name: "LM Studio",
        model_prefix: "lm_studio/",
        docs_url: "https://aider.chat/docs/llms/lm-studio.html",
        console_url: None,
        fields: &[
            plain(
                "LM_STUDIO_API_BASE",
                "Server URL",
                "http://localhost:1234/v1",
            ),
            secret("LM_STUDIO_API_KEY", "API key (any non-empty value works)"),
        ],
        catalog: Catalog::LocalHttp {
            base_field: "LM_STUDIO_API_BASE",
            path: "/models",
            shape: LocalShape::OpenAiModels,
        },
        note: Some("Runs locally. LM Studio ignores the key's value but requires one."),
    },
    AiderProvider {
        id: "azure",
        display_name: "Azure OpenAI",
        model_prefix: "azure/",
        docs_url: "https://aider.chat/docs/llms/azure.html",
        console_url: Some("https://portal.azure.com"),
        fields: &[
            secret("AZURE_API_KEY", "API key"),
            plain(
                "AZURE_API_BASE",
                "Endpoint",
                "https://<resource>.openai.azure.com",
            ),
            plain("AZURE_API_VERSION", "API version", "2024-12-01-preview"),
        ],
        catalog: Catalog::Manual {
            hint: "Enter your deployment name — Azure models are named by you, not by a catalog.",
        },
        note: None,
    },
    AiderProvider {
        id: "bedrock",
        display_name: "Amazon Bedrock",
        model_prefix: "bedrock/",
        docs_url: "https://aider.chat/docs/llms/bedrock.html",
        console_url: Some("https://console.aws.amazon.com/bedrock"),
        fields: &[
            secret("AWS_ACCESS_KEY_ID", "Access key ID"),
            secret("AWS_SECRET_ACCESS_KEY", "Secret access key"),
            plain("AWS_REGION_NAME", "Region", "us-east-1"),
        ],
        catalog: Catalog::LitellmDb,
        note: None,
    },
    AiderProvider {
        id: "vertex",
        display_name: "Google Vertex AI",
        model_prefix: "vertex_ai/",
        docs_url: "https://aider.chat/docs/llms/vertex.html",
        console_url: Some("https://console.cloud.google.com/vertex-ai"),
        fields: &[
            plain(
                "GOOGLE_APPLICATION_CREDENTIALS",
                "Service account JSON path",
                "/path/to/credentials.json",
            ),
            plain("VERTEXAI_PROJECT", "Project id", "my-gcp-project"),
            plain("VERTEXAI_LOCATION", "Location", "us-east5"),
        ],
        catalog: Catalog::LitellmDb,
        note: Some("Authenticates with a service account file rather than an API key."),
    },
    AiderProvider {
        id: "github-copilot",
        display_name: "GitHub Copilot",
        model_prefix: "openai/",
        docs_url: "https://aider.chat/docs/llms/github.html",
        console_url: Some("https://github.com/settings/copilot"),
        fields: &[
            secret("OPENAI_API_KEY", "Copilot token"),
            plain(
                "OPENAI_API_BASE",
                "Endpoint",
                "https://api.githubcopilot.com",
            ),
        ],
        catalog: Catalog::Manual {
            hint: "Enter a Copilot model id, for example `gpt-4o` or `claude-3.7-sonnet-thought`.",
        },
        note: Some("Uses the OpenAI-compatible endpoint, so it can't be enabled alongside OpenAI."),
    },
    AiderProvider {
        id: "openai-compat",
        display_name: "OpenAI-compatible endpoint",
        model_prefix: "openai/",
        docs_url: "https://aider.chat/docs/llms/openai-compat.html",
        console_url: None,
        fields: &[
            secret("OPENAI_API_KEY", "API key"),
            plain("OPENAI_API_BASE", "Endpoint", "https://api.example.com/v1"),
        ],
        catalog: Catalog::Manual {
            hint: "Enter the model id exactly as your endpoint expects it.",
        },
        note: Some("For any service that speaks the OpenAI API."),
    },
];

pub fn all() -> &'static [AiderProvider] {
    PROVIDERS
}

pub fn by_id(id: &str) -> Option<&'static AiderProvider> {
    all().iter().find(|p| p.id == id)
}

/// Which provider owns a model id, by longest matching prefix.
///
/// Longest-match matters: `openrouter/anthropic/claude-...` starts with
/// neither `anthropic/` nor `openrouter/anthropic/` by accident, but a
/// naive scan that checked `anthropic/` first would still need to not
/// match it. Sorting by prefix length makes the intent explicit.
pub fn provider_for_model(model: &str) -> Option<&'static AiderProvider> {
    let mut matches: Vec<_> = all()
        .iter()
        .filter(|p| model.starts_with(p.model_prefix))
        .collect();
    matches.sort_by_key(|p| std::cmp::Reverse(p.model_prefix.len()));
    matches.first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_prefixes_are_sane() {
        for provider in all() {
            assert!(!provider.id.is_empty());
            assert!(
                provider.model_prefix.ends_with('/'),
                "{} prefix must end with '/' or model ids concatenate wrongly",
                provider.id
            );
            assert!(
                !provider.fields.is_empty(),
                "{} declares no credential fields",
                provider.id
            );
        }
    }

    #[test]
    fn remote_providers_link_to_a_key_console() {
        // The whole point of `console_url`: a provider that wants a secret
        // must be able to say where one comes from. Only local servers and
        // arbitrary custom endpoints are exempt, because no such page
        // exists for them.
        const NO_CONSOLE: &[&str] = &["ollama", "lm-studio", "openai-compat"];
        for provider in all() {
            let wants_secret = provider.fields.iter().any(|f| f.kind == FieldKind::Secret);
            if wants_secret && !NO_CONSOLE.contains(&provider.id) {
                assert!(
                    provider.console_url.is_some(),
                    "{} asks for a key but doesn't say where to get one",
                    provider.id
                );
            }
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for provider in all() {
            assert!(
                seen.insert(provider.id),
                "duplicate provider id {}",
                provider.id
            );
        }
    }

    #[test]
    fn a_local_catalogs_base_field_exists() {
        // A typo in `base_field` would silently mean "never enumerate".
        for provider in all() {
            if let Catalog::LocalHttp { base_field, .. } = provider.catalog {
                assert!(
                    provider.fields.iter().any(|f| f.env_var == base_field),
                    "{} points its catalog at {base_field}, which it doesn't declare",
                    provider.id
                );
            }
        }
    }

    #[test]
    fn openai_family_is_detected_as_conflicting() {
        // The three OpenAI-compatible providers share OPENAI_API_KEY, so
        // enabling two would silently cross their endpoints. If this stops
        // holding, `conflicts_with` has lost its teeth.
        let openai = by_id("openai").unwrap().conflicts_with();
        assert!(openai.contains(&"github-copilot"));
        assert!(openai.contains(&"openai-compat"));
        // ...while an unrelated provider conflicts with nothing.
        assert!(by_id("openrouter").unwrap().conflicts_with().is_empty());
    }

    #[test]
    fn longest_prefix_wins_for_model_ownership() {
        assert_eq!(
            provider_for_model("openrouter/anthropic/claude-x")
                .unwrap()
                .id,
            "openrouter"
        );
        assert_eq!(
            provider_for_model("anthropic/claude-x").unwrap().id,
            "anthropic"
        );
        assert_eq!(
            provider_for_model("ollama_chat/llama3").unwrap().id,
            "ollama"
        );
        assert!(provider_for_model("bare-model-name").is_none());
    }
}
