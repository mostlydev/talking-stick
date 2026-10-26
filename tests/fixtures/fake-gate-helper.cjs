#!/usr/bin/env node
// A stand-in for tt-human-gate in the acceptance kit's self-test: it answers
// from the step's reason, as a person following the instruction would. In the
// background domain it is unavailable, as LocalAuthentication would be there.
let reason = "";
process.stdin.on("data", (chunk) => { reason += chunk; }).on("end", () => {
  // In the background domain the dialog is unavailable, unless the fault says one appeared and was cancelled.
  if ((process.env.FAKE_DOMAIN ?? "").startsWith("user/")) {
    if (process.env.TT_GATE_ACCEPTANCE_FAULT === "background-timeout") { setInterval(() => {}, 1000); return; }
    process.exit(process.env.TT_GATE_ACCEPTANCE_FAULT === "background-dialog" ? 3 : 2);
  }
  if (reason.includes("do not answer") || process.env.TT_GATE_ACCEPTANCE_FAULT === "timeout") {
    // With inspect-empty, this helper ignores SIGTERM and stays alive until the test releases it
    // (its release file appears), with a bounded emergency exit, so cleanup can't outrun it.
    if (process.env.TT_GATE_ACCEPTANCE_FAULT === "inspect-empty") {
      process.on("SIGTERM", () => {});
      const release = process.env.TT_GATE_ACCEPTANCE_RELEASE;
      const deadline = Date.now() + 30_000;
      setInterval(() => { if ((release && require("node:fs").existsSync(release)) || Date.now() > deadline) process.exit(0); }, 50);
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (reason.includes("CANCEL")) process.exit(3);
  if (reason.includes("CONFIRM")) process.exit(0);
  process.exit(2);
});
