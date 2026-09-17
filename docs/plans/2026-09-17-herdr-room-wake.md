# Herdr room wake and invitations

The operator authorized Herdr support after discovering that Grok's active-turn
hooks do not wake an idle session. Wake must only reach agents that previously
joined the exact room. The operator also wants easy room startup across harnesses
without typing individually in each pane, while keeping unrelated panes separate.

## User workflow

1. Opening `tt chat` opens or resumes its room and shows membership/delivery state.
   Opening alone does not submit prompts to agents or enroll nearby processes.
2. Ordinary directed messages and `@everyone` address joined members. Existing
   native transports remain preferred; Herdr is an idle-wake fallback when it can
   establish the intended session safely. Merely sharing a folder is not consent
   to receive the room's subsequent messages.
3. A separate explicit human invitation action can discover unjoined agents in
   the exact canonical folder/room and ask them to join. Default shape pending
   operator preference: `/invite` displays eligible targets; `/invite @everyone`
   invites those candidates. Agent messages never implicitly invite processes.
   An invitation is not enrollment: the receiving agent must run `tt join`.
4. An empty room may show an invitation hint so startup remains one chat entry
   point. No background broadcast on launch, reconnect, resize or history replay.

## Membership and target boundaries

- Require a current member of this room, local host, matching harness kind and
  exact harness session ID. An agent that left is not a wake target.
- Discover Herdr session/pane identity from the member's own trusted registration;
  do not rely on focus, display-name matches or arbitrary operator message text.
- Never use a directory-prefix match for invitation eligibility. Nested rooms,
  independent repos, sibling worktrees, and deliberately unrelated panes must not
  be swept into a parent room. Canonicalize paths and resolve exact room scope.
- Session continuation can retain membership only when the harness session still
  matches. A new occupant of an old pane must never receive the previous session's
  messages. A stale endpoint must fail closed.

## Blocking transport requirements

Before enabling Herdr delivery, verify its server/API supports:

- Send-time expected-session validation, not just list-then-send checks.
- Preserving or rejecting an unsent user draft; never appending to or submitting
  the operator's draft. Idle state alone is not evidence of an empty composer.
- Refusing blocked/unknown states without sending input or answering dialogs.
- Unambiguous failure versus possible submission. An uncertain timeout must not
  cause a duplicate send through another transport.

These are not proven by `herdr agent list` exposing session IDs. Installed CLI
`agent prompt` currently accepts a pane/name target rather than an expected
session parameter; Claude is inspecting server semantics before code enables it.
No pane prompt has been sent during this investigation.

## Delivery semantics

Durable room write comes first. Submission is not model receipt: retain exact-event
acknowledgement and the existing delivered receipt. When no verified transport or
live listener exists, show that the message waits for the agent to resume, rather
than implying it has entered the harness. Prefer native delivery when available;
never inject into a busy composer merely because an urgent message arrived.

## Acceptance cases

Joined correct-room idle agent wakes and acknowledges once; active hooks continue
to deliver without a second wake; absent/left/wrong-room/new-session targets do
not receive prompts; nested worktrees do not match invitation scope; unsent drafts
and approval dialogs remain unchanged; ambiguous timeout does not double-submit;
blocked or manual-only status is honest; reopening chat does not send invitations.
Live testing uses consenting test sessions and checks both receipt and UI state.

No release until the operator accepts the resulting chat behavior.

## Research outcome and implementation split

Existing Herdr prompt is insufficient: it writes into the composer and schedules
Enter later, validates only harness kind, and exposes no draft model. A last-second
session lookup, a body-free prompt, or skipping focused panes cannot establish the
required guarantees. Do not enable an adapter against that interface.

A guarded server path is being investigated in an isolated Herdr checkout. It
must validate session, room path and process incarnation at send time, preserve
input boundaries, and refuse any uncertain/dirty composer. Input-source tracking
and a verified empty-composer predicate may both be needed; unknown capability
means unavailable, never optimistic fallback. Do not replace the operator's live
Herdr server to test this.

Talking Stick interim fix: manual standby renders “waiting for resume”; the chat
integration test confirms receipt later changes it to “delivered” without moving
history or altering the unsent draft. Focused chat suite: 55 tests passed.
