# shellcheck shell=bash
# KOBE-181 (65f of KOBE-65): scheduled runs end to end. Sourced by e2e/run.sh after the model setup
# (KOBE-40/41) and the gallery agent Kobe (KOBE-89, KOBE-254); uses its helpers (psql_kobe, probe, retry, answers,
# contains, wait_for) and the Owner's real sandbox with the fake model.
#
# No real interval is waited for (the minimum is 15 min): schedules are created through the API with
# a daily time 12 h away, then one occurrence is pulled forward in Postgres (next_due_at = now) and
# the runner fires it within one tick (5 s in the e2e values, dev/values.yaml). The next occurrence
# is then 12 h away, so any further thread would be a bug.
#
# - The Owner: a run whose bash call would ask is skipped and reported (run_skipped_actions, the
#   thread's summary entry, the terminal event), then a plain run succeeds. Both notify in-app and
#   by email (Mailpit).
# - A member with a zero token budget: the fire is a failed run (budget blocked), notified in-app and
#   by email. The member is then deactivated: the schedule is paused and never fires again, even
#   when due, and even if the pause had been lost (the fire-time check skips it).

SCHED_USER_ID=7e2e0000-0000-4000-8000-000000000181
SCHED_EMAIL=sched@e2e.test
SCHED_NONE=00000000-0000-4000-8000-000000000000
MAILPIT_API=http://mailpit.kobe-deps:8025/api/v1

sched_as() { # email "METHOD /path [json]"... → "<status> <body>" per request, as that user in the e2e team
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node --input-type=module -e "
    const base = 'http://127.0.0.1:8080', origin = process.env.KOBE_PUBLIC_URL;
    const h = { origin, 'content-type': 'application/json', 'x-kobe-team': '$E2E_TEAM_ID' };
    let login;
    for (let i = 0; i < 4; i++) { // sign-in is rate limited (3 per 10 s): wait out a 429
      login = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: h,
        body: JSON.stringify({ email: process.argv[1], password: 'e2e owner password' }) });
      if (login.status !== 429) break;
      await new Promise((r) => setTimeout(r, 11000));
    }
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    await fetch(base + '/v1/me/teams/active', { method: 'PUT', headers: { ...h, cookie },
      body: JSON.stringify({ teamId: '$E2E_TEAM_ID' }) });
    for (const req of process.argv.slice(2)) {
      const [method, path, ...rest] = req.split(' ');
      const body = rest.join(' ');
      const res = await fetch(base + path, { method, headers: { ...h, cookie }, ...(body ? { body } : {}) });
      console.log(res.status + ' ' + (await res.text()).replace(/\n/g, ' ').slice(0, 3000));
    }
  " "$@" 2>&1
}

sched_id_of() { sed -n 's/.*"schedule_id":"\([0-9a-f-]*\)".*/\1/p' | head -1; } # stdin: a create answer
sched_body() { # agent-id prompt at → a create body (daily, UTC, email on)
  printf '{"agent_id":"%s","prompt":"%s","recurrence":{"kind":"daily","at":"%s"},"tz":"UTC","notify_email":true}' "$1" "$2" "$3"
}
sched_pull_due() { psql_kobe "UPDATE schedules SET next_due_at = date_trunc('second', now()) - interval '1 second' WHERE id = '$1'" >/dev/null; }
sched_threads() { psql_kobe "SELECT count(*) FROM threads WHERE schedule_id = '${1:-$SCHED_NONE}'"; }
sched_fires() { psql_kobe "SELECT count(*) FROM events WHERE kind = 'schedule.fire' AND ref->>'schedule_id' = '${1:-$SCHED_NONE}'"; }
sched_run() { psql_kobe "SELECT coalesce(last_run_id::text, '') FROM schedules WHERE id = '${1:-$SCHED_NONE}'"; }
sched_skips() { psql_kobe "SELECT count(*) FROM events WHERE kind = 'schedule.skip' AND ref->>'schedule_id' = '${1:-$SCHED_NONE}' AND ref->>'reason' = '$2'"; }
sched_status() { psql_kobe "SELECT status FROM runs WHERE id = '${1:-$SCHED_NONE}'"; }
sched_note() { psql_kobe "SELECT kind || ':' || coalesce(skipped_count::text, '-') FROM notifications WHERE run_id = '${1:-$SCHED_NONE}'"; }
sched_mail() { psql_kobe "SELECT e.status FROM notification_emails e JOIN notifications n ON n.team_id = e.team_id AND n.id = e.notification_id WHERE n.run_id = '${1:-$SCHED_NONE}'"; }

sched_fire() { # label schedule-id seconds → pulls it due, waits for its thread and the run's end, checks one thread
  local run
  sched_pull_due "$2"
  contains "$1: the runner fires it within a tick (one thread in Scheduled)" '^1$' "$(wait_for 60 '^1$' sched_threads "$2")"
  run=$(wait_for 30 '^[0-9a-f-]{36}$' sched_run "$2")
  printf '     %s: run %s ended %s\n' "$1" "$run" \
    "$(wait_for "$3" '^(completed|failed|interrupted|cancelled|budget_stopped)$' sched_status "$run")"
}

scheduled_run_checks() {
  local t0=$SECONDS agent at s1 s2 s3 out run1 run2 run3 thread1 note1
  agent=$(psql_kobe "SELECT id FROM install_agents WHERE scope = 'gallery' AND gallery_key = 'kobe' AND archived_at IS NULL")
  at=$(printf '%02d:00' $(((10#$(date -u +%H) + 12) % 24)))
  psql_kobe "INSERT INTO users (id, name, email, email_verified) VALUES ('$SCHED_USER_ID', 'E2E scheduler', '$SCHED_EMAIL', true) ON CONFLICT DO NOTHING;
    INSERT INTO accounts (user_id, account_id, provider_id, password)
      SELECT '$SCHED_USER_ID', '$SCHED_USER_ID', 'credential', password FROM accounts
      WHERE provider_id = 'credential' AND user_id = '$owner_id'
        AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = '$SCHED_USER_ID');
    INSERT INTO team_members (team_id, user_id, role) VALUES ('$E2E_TEAM_ID', '$SCHED_USER_ID', 'member') ON CONFLICT DO NOTHING;" >/dev/null

  # --- The Owner: a skipped write, then a plain success ------------------------------------------
  out=$(sched_as owner@e2e.test \
    "POST /v1/schedules $(sched_body "$agent" "bash: echo kobe-181 > /workspace/kobe-181.txt" "$at")" \
    "POST /v1/schedules $(sched_body "$agent" "kobe-181 hello" "$at")" \
    "PUT /v1/team/budgets/members/$SCHED_USER_ID {\"monthly_tokens\":0}")
  printf '     schedules: %s\n' "$(printf '%s' "$out" | cut -c1-90 | tr '\n' '|')"
  expect "the Owner creates two daily schedules with email on (201) and sets the member's zero budget (200)" '^(201|200) ' "$out"
  s1=$(printf '%s\n' "$out" | sed -n 1p | sched_id_of)
  s2=$(printf '%s\n' "$out" | sed -n 2p | sched_id_of)

  sched_fire "skipped write" "$s1" 300
  run1=$(sched_run "$s1")
  thread1=$(psql_kobe "SELECT id FROM threads WHERE schedule_id = '${s1:-$SCHED_NONE}'")
  contains "skipped write: a scheduled run (trigger schedule) completed" '^schedule:completed$' \
    "$(psql_kobe "SELECT trigger::text || ':' || status::text FROM runs WHERE id = '${run1:-$SCHED_NONE}'")"
  contains "skipped write: the bash call that would ask was skipped, not run (scheduled_run_no_prompt)" \
    '^bash:scheduled_run_no_prompt$' \
    "$(psql_kobe "SELECT tool || ':' || reason FROM run_skipped_actions WHERE run_id = '${run1:-$SCHED_NONE}'")"
  contains "skipped write: run.completed reports the skipped action" '^1$' \
    "$(psql_kobe "SELECT count(*) FROM run_events WHERE run_id = '${run1:-$SCHED_NONE}' AND type = 'run.completed' AND payload->'skipped_actions'->0->>'tool' = 'bash'")"
  contains "skipped write: the thread holds the skipped-actions summary, off the leaf" '^1:true$' \
    "$(psql_kobe "SELECT count(*) || ':' || bool_and(t.leaf_entry_id IS DISTINCT FROM e.entry_id)::text FROM thread_entries e JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
      WHERE e.thread_id = '${thread1:-$SCHED_NONE}' AND e.type = 'custom_message' AND e.payload->>'customType' = 'kobe.skipped_actions'")"
  contains "skipped write: the in-app notification says so, with the count" '^schedule.run.skipped_actions:1$' \
    "$(wait_for 30 '^schedule' sched_note "$run1")"
  contains "skipped write: its email was sent" '^sent$' "$(wait_for 120 '^(sent|failed|skipped)$' sched_mail "$run1")"

  sched_fire "success" "$s2" 180
  run2=$(sched_run "$s2")
  contains "success: the run completed with nothing skipped" '^completed:0$' \
    "$(psql_kobe "SELECT r.status::text || ':' || (SELECT count(*) FROM run_skipped_actions s WHERE s.run_id = r.id) FROM runs r WHERE r.id = '${run2:-$SCHED_NONE}'")"
  contains "success: the in-app notification says it succeeded" '^schedule.run.succeeded:-$' \
    "$(wait_for 30 '^schedule' sched_note "$run2")"
  contains "success: its email was sent" '^sent$' "$(wait_for 120 '^(sent|failed|skipped)$' sched_mail "$run2")"
  contains "each schedule fired exactly once, one thread each (the next run is 12 h away)" '^1:1:1:1$' \
    "$(sched_fires "$s1"):$(sched_threads "$s1"):$(sched_fires "$s2"):$(sched_threads "$s2")"

  note1=$(psql_kobe "SELECT id FROM notifications WHERE run_id = '${run1:-$SCHED_NONE}'")
  out=$(sched_as owner@e2e.test "GET /v1/notifications?unread=true&limit=10" \
    "POST /v1/notifications/read {\"notification_ids\":[\"${note1:-$SCHED_NONE}\"]}" \
    "POST /v1/notifications/read {\"all\":true}" "GET /v1/notifications?unread=true")
  contains "the Owner's bell lists both, unread" "^200 .*\"thread_id\":\"$thread1\".*\"unread_count\":2" \
    "$(printf '%s\n' "$out" | sed -n 1p)"
  contains "marking one read counts it" '^200 \{"updated":1,"unread_count":1\}$' "$(printf '%s\n' "$out" | sed -n 2p)"
  contains "marking all read clears the badge" '^200 \{"updated":1,"unread_count":0\}$' "$(printf '%s\n' "$out" | sed -n 3p)"
  contains "no unread notifications are left" '^200 \{"notifications":\[\],"unread_count":0,' "$(printf '%s\n' "$out" | sed -n 4p)"

  # --- A member: a failed run, then deactivation stops the schedule --------------------------------
  out=$(sched_as "$SCHED_EMAIL" "POST /v1/schedules $(sched_body "$agent" "kobe-181 member" "$at")")
  contains "the member creates a schedule (201)" '^201 ' "$out"
  s3=$(printf '%s\n' "$out" | sched_id_of)
  sched_fire "failure" "$s3" 60
  run3=$(sched_run "$s3")
  contains "failure: the budget blocked the run at fire time (failed)" '^failed:budget_blocked$' \
    "$(psql_kobe "SELECT r.status::text || ':' || coalesce(e.ref->>'outcome', '-') FROM runs r JOIN events e ON e.kind = 'schedule.fire' AND e.ref->>'run_id' = r.id::text WHERE r.id = '${run3:-$SCHED_NONE}'")"
  contains "failure: the in-app notification says it failed" '^schedule.run.failed:-$' "$(wait_for 30 '^schedule' sched_note "$run3")"
  contains "failure: its email was sent (before the member is deactivated)" '^sent$' \
    "$(wait_for 120 '^(sent|failed|skipped)$' sched_mail "$run3")"
  out=$(sched_as "$SCHED_EMAIL" "GET /v1/notifications?unread=true" "POST /v1/notifications/read {\"all\":true}")
  contains "the member's bell lists the failure" '^200 .*"kind":"schedule.run.failed".*"unread_count":1,' "$(printf '%s\n' "$out" | sed -n 1p)"
  contains "the member marks it read" '^200 \{"updated":1,"unread_count":0\}$' "$(printf '%s\n' "$out" | sed -n 2p)"

  out=$(sched_as owner@e2e.test "POST /v1/site/users/$SCHED_USER_ID/deactivate" "POST /v1/schedules/$s3/resume")
  contains "the Owner deactivates the member" '^200 .*"deactivated":true' "$(printf '%s\n' "$out" | sed -n 1p)"
  contains "deactivation paused the member's schedule" '^false:deactivation:true$' \
    "$(psql_kobe "SELECT active::text || ':' || coalesce(paused_by, '-') || ':' || (next_due_at IS NULL)::text FROM schedules WHERE id = '${s3:-$SCHED_NONE}'")"
  contains "a team admin cannot resume it (only admin-paused schedules: 404)" '^404 ' "$(printf '%s\n' "$out" | sed -n 2p)"
  # Due again while paused: the runner never picks it up (three ticks).
  sched_pull_due "$s3"
  sleep 15
  contains "the paused schedule does not fire even when due" '^1:1$' "$(sched_fires "$s3"):$(sched_threads "$s3")"
  # As if the pause had been lost (an old row, a failed hook): the fire-time check skips it.
  psql_kobe "UPDATE schedules SET active = true, paused_by = NULL, next_due_at = date_trunc('second', now()) - interval '1 second' WHERE id = '${s3:-$SCHED_NONE}'" >/dev/null
  contains "an active schedule of a deactivated owner is skipped at fire time (user_inactive)" '^1$' \
    "$(wait_for 30 '^1$' sched_skips "$s3" user_inactive)"
  contains "the deactivated member's schedule never fired again, nor notified" '^1:1:1$' \
    "$(sched_fires "$s3"):$(sched_threads "$s3"):$(psql_kobe "SELECT count(*) FROM notifications WHERE user_id = '$SCHED_USER_ID'")"
  psql_kobe "UPDATE schedules SET active = false, paused_by = 'deactivation', next_due_at = NULL WHERE id = '${s3:-$SCHED_NONE}'" >/dev/null

  # --- Mailpit: what each owner received ------------------------------------------------------------
  local owner_q="'$MAILPIT_API/search?query=to%3Aowner%40e2e.test%20subject%3Ascheduled&limit=50'"
  local member_q="'$MAILPIT_API/search?query=to%3Asched%40e2e.test&limit=50'"
  out=$(probe "$NS" "$(retry "$(answers "$member_q") | grep -q 'Your scheduled run failed'"); \
$(answers "$owner_q"); echo; echo member:; $(answers "$member_q")")
  contains "Mailpit: the Owner got 'finished with skipped actions'" 'Your scheduled run finished with skipped actions in the E2E team' "$(printf '%s\n' "$out" | sed '/^member:/,$d')"
  contains "Mailpit: the Owner got 'succeeded'" 'Your scheduled run succeeded in the E2E team' "$(printf '%s\n' "$out" | sed '/^member:/,$d')"
  contains "Mailpit: the member got one scheduled-run email" '^1$' \
    "$(printf '%s\n' "$out" | sed -n '/^member:/,$p' | grep -o '"Subject":"Your scheduled run[^"]*"' | wc -l | tr -d ' ')"
  contains "Mailpit: the member's email is the failure" 'Your scheduled run failed in the E2E team' "$(printf '%s\n' "$out" | sed -n '/^member:/,$p')"
  printf '     scheduled runs e2e: %ss\n' "$((SECONDS - t0))"
}
