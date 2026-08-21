pub mod adapter;
pub mod aider;
pub mod capabilities;
pub mod claude;
pub mod codex;
pub mod cursor_agent;
pub mod events;
pub mod manager;
pub mod one_shot;
pub mod opencode;
pub mod registry;
pub mod sessions;
pub mod slash_commands;
pub mod transcripts;

pub use registry::{AgentKind, CliStatus};

/// Removes ANSI SGR escape sequences from a line.
///
/// Needed in two unrelated places, because two of the wrapped CLIs colour
/// output that is not a terminal: `cursor-agent --list-models` colours its
/// list (which silently broke model parsing), and Aider colours its
/// tracebacks (which rendered as literal `^[[35m` fragments). Written by
/// hand rather than pulled in as a dependency — the sequences involved are
/// all `ESC [ … <letter>`, which is a few lines to skip.
pub fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.next() != Some('[') {
            continue;
        }
        for tail in chars.by_ref() {
            if tail.is_ascii_alphabetic() {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_coloured_model_lines_parse() {
        // Exactly the bytes `cursor-agent --list-models` writes to a pipe.
        // Before this, the literal " - " that `list_agent_models` splits on
        // appeared in none of its 208 lines, so the model picker was always
        // empty.
        let raw = "\u{1b}[36mauto\u{1b}[39m \u{1b}[2m- Auto\u{1b}[22m\u{1b}[2m (default)\u{1b}[22m";
        let clean = strip_ansi(raw);
        assert_eq!(clean, "auto - Auto (default)");
        let (id, label) = clean
            .trim()
            .split_once(" - ")
            .expect("separator should survive");
        assert_eq!(id, "auto");
        assert_eq!(label, "Auto (default)");
    }

    #[test]
    fn plain_text_is_left_alone() {
        assert_eq!(
            strip_ansi("gpt-5.3-codex - Codex 5.3"),
            "gpt-5.3-codex - Codex 5.3"
        );
    }
}
