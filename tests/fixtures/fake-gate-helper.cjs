#!/usr/bin/env node
// A stand-in for tt-human-gate in the acceptance kit's self-test: it answers
// from the step's reason, as a person following the instruction would. In the
// background domain it is unavailable, as LocalAuthentication would be there.
let reason = "";
process.stdin.on("data", (chunk) => { reason += chunk; }).on("end", () => {
  if ((process.env.FAKE_DOMAIN ?? "").startsWith("user/")) process.exit(2);
  if (reason.includes("do not answer") || process.env.TT_GATE_ACCEPTANCE_FAULT === "timeout") { setInterval(() => {}, 1000); return; }
  if (reason.includes("CANCEL")) process.exit(3);
  if (reason.includes("CONFIRM")) process.exit(0);
  process.exit(2);
});
