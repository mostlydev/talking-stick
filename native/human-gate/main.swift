// tt-human-gate: asks the person at the console to confirm one supervisor
// control request (docs/supervisor.md, "Human control"). The daemon runs it
// and writes the request's reason on stdin. Exit 0 means confirmed, 3 means
// refused or cancelled, anything else means unavailable. It never reuses an
// earlier confirmation: each run evaluates a fresh context with no Touch ID
// reuse window and invalidates it afterwards.
import Foundation
import LocalAuthentication

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let reason = String(data: input, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !reason.isEmpty, reason.utf8.count <= 4096 else { exit(2) }

let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
context.interactionNotAllowed = false
var available: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &available) else { exit(2) }

let done = DispatchSemaphore(value: 0)
var confirmed = false
var unavailable = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
  confirmed = success
  if let code = (error as? LAError)?.code, code == .notInteractive || code == .passcodeNotSet { unavailable = true }
  done.signal()
}
done.wait()
context.invalidate()
exit(confirmed ? 0 : unavailable ? 2 : 3)
