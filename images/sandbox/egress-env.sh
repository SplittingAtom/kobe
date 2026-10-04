# Kobe egress for the tools Pi runs (KOBE-39). Root-owned and read-only; Pi's environment names it
# in BASH_ENV, so every non-interactive bash (each bash tool call) sources it before the command.
#
# It reads the sandbox's current egress token from the file kobe-sandbox-agent rotates
# (KOBE_EGRESS_TOKEN_FILE) with the `read` builtin (no process, nothing in any argv or log) and
# exports the proxy variables curl, pip, npm, git and Python use:
#   HTTPS_PROXY=http://<thread id>:<token>@<egress proxy host:port>
# The thread id lets the proxy show a blocked request in this thread. Without a token file nothing
# is exported, and direct connections are refused by the sandbox's NetworkPolicy anyway.
# Only POSIX/bash builtins below: it runs before every command. Tracing (`bash -x`, whose output
# becomes the tool result) is paused while the token is handled, so it never shows in a trace.
case "$-" in *x*) __kobe_egress_xtrace=1; set +x ;; *) __kobe_egress_xtrace="" ;; esac
if [ -n "${KOBE_EGRESS_TOKEN_FILE:-}" ] && [ -n "${KOBE_EGRESS_PROXY:-}" ] && [ -r "$KOBE_EGRESS_TOKEN_FILE" ]; then
  __kobe_egress_token=""
  IFS= read -r __kobe_egress_token < "$KOBE_EGRESS_TOKEN_FILE" || true
  __kobe_egress_user="${KOBE_THREAD_ID:-kobe}"
  __kobe_egress_host="${KOBE_EGRESS_PROXY#http://}"
  __kobe_egress_host="${__kobe_egress_host%/}"
  case "$__kobe_egress_token$__kobe_egress_user$__kobe_egress_host" in
    *[!A-Za-z0-9._:-]* | "") ;; # anything unexpected: export nothing (never build a URL from it)
    *)
      if [ -n "$__kobe_egress_token" ]; then
        __kobe_egress_url="http://${__kobe_egress_user}:${__kobe_egress_token}@${__kobe_egress_host}"
        export HTTPS_PROXY="$__kobe_egress_url" https_proxy="$__kobe_egress_url"
        export HTTP_PROXY="$__kobe_egress_url" http_proxy="$__kobe_egress_url"
      fi
      ;;
  esac
  unset __kobe_egress_token __kobe_egress_user __kobe_egress_host __kobe_egress_url
fi
if [ -n "$__kobe_egress_xtrace" ]; then unset __kobe_egress_xtrace; set -x; else unset __kobe_egress_xtrace; fi
