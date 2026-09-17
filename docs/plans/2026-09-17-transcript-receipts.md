# Message receipts in the transcript

The operator rejected footer receipts because they did not identify a message,
and rejected the unused space above the prompt.

Receipts now belong to message event IDs and render immediately below the body.
Out-of-order acknowledgements update their own message, not the latest send or
an agent-wide status. The footer retains room activity and input hints only.
The inline panel reserves suggestion rows only when suggestions exist, reducing
its ordinary empty-draft height from eight rows to four.

Normal-screen output explicitly wraps printed rows. This avoids relying on
terminal-specific emoji wrapping when calculating a receipt's physical row.
Only known receipt rows still on the active screen are rewritten. Scrolled-out
native history cannot be edited by cursor movement; loading saved history reads
its durable receipts. Fullscreen mode renders receipts from the transcript model.

Resize rebuilds the visible tail and composer from the model using cursor-home
and erase-below (ED0), never ED2/ED3 or an alternate screen. This avoids guessed
cursor offsets that can erase messages or strand draft copies after reflow.
Receipt anchors are rebuilt from that same layout. Native scrollback remains;
narrowing can leave repeated recent lines at the scrollback boundary because the
terminal reflows before the application receives the resize event.

Verification:
- Full suite: 628 passed, 1 skipped.
- Typecheck and build passed.
- Receipt tests cover out-of-order acceptance, wrapped wide/emoji messages
  between send and receipt, resize before a late receipt, intact drafts, and
  absence of footer receipts in inline and fullscreen modes.
- Existing resize, history, selection-mode and input tests retained.
- Focused rerun after replacing ED2 with home+ED0: 98 passed; final full
  rerun also covers batched historical receipts without invented pending states.
- Independent review approved the approach; requested history receipt batching
  and omission of invented pending states for old messages, both implemented.
- Operator visual acceptance: pending.

Herdr idle-wake work remains separate; no unsafe pane prompting enabled.
