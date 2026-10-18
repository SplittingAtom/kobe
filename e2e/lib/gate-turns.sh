# shellcheck shell=bash
# Conversation helpers shared by e2e/gate3.sh and e2e/gate4/stories.sh (KOBE-231, KOBE-232); sourced.
# Expects: BASE, FAKE (1: the scripted model's prompt grammar) and client() (e2e/lib/gate-common.sh)
# with a client whose MODES include `turn` (e2e/gate3/client.mjs).

json_str() { # text → a JSON string literal
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}
show() { # label output → one evidence line (the bulky keys trimmed)
  printf '     %s: %s\n' "$1" "$(grep -vE '^(text|tool_output)=' <<<"$2" | tr '\n' ' ' | cut -c1-600)"
}

# Prompts: the scripted model's grammar, or plain instructions for a real model.
bash_prompt() { # command
  if ((FAKE)); then printf 'bash: %s' "$1"; else
    printf 'Use your bash tool to run exactly this command, once, then reply with its output verbatim: %s' "$1"
  fi
}
tool_prompt() { # tool json-arguments
  if ((FAKE)); then printf 'tool: %s %s' "$1" "$2"; else
    printf 'Call the %s tool exactly once with exactly these arguments (JSON): %s. Then reply in one short sentence.' "$1" "$2"
  fi
}
# A message from a user; extra JSON fields: threadId, agentId, projectId, fileIds, hold, ...
turn() { # user-json text [extra-json-fields]
  client "$(printf '{"mode":"turn","base":"%s","user":%s,"content":%s%s,"timeoutMs":300000}' \
    "$BASE" "$1" "$(json_str "$2")" "${3:+,$3}")"
}
said() { grep -E '^(text|tool_output)=' <<<"$1" || true; } # what the model said and the tools returned

