# Frontend updater integration handoff

Frontend is implemented on the approved branch without running live updater calls,
changing live settings/data or touching an installed application. The sole production
adapter is `src/services/updatePort.ts`, bound to `native-updater-contract.md` protocol 1.

The adapter gates browser/dev, unsupported platforms/architecture and Mini installation.
It observes the shared job, maps native deferred responses, consumes only actual terminal
receipts, and refreshes a selection before download while requiring the frozen version.
Main is the sole native install-authorized window; restoring or joining an existing job
has no local click ownership. No endpoint accepts a caller URL/path. Errors are normalized
into Russian frontend messages. The backend currently returns broad combined error text,
so checksum/network/disk specificity is limited until it supplies stable error codes.

App mounts the singleton observer in every window; Settings navigation does not own its
lifetime. Channel writes lock during a job; background release checks cannot replace its
frozen target. Wizard/Mini acquire the documented native capture fence before media and
release after capture/chunks settle. A local event plus BroadcastChannel revokes automatic
intent across frontend windows. Backend's monotonic `autoEligible` latch independently
covers backend activity. Final native/backend checks remain authoritative. No success is
inferred from task acknowledgement or `awaiting_exit`. No quarantine/backup operations
are performed by the frontend. Permission failure offers manual fallback, no OS prompt
is claimed.

Integration limits for parent review:

- Existing backend reports digest-verified `ready` before DMG bundle verification;
  bundle verification occurs during native `preparing`, shown as installing. The UI
  supports a verifying stage if backend adds a separate cancellable one later.
- Native IPC rejects installation outside a supported packaged main window; there is
  no preflight writable capability, so permissions failures surface after an attempt.
- Combined backend error prose prevents exact error classification. Stable codes are
  recommended. Recovery-required and rollback receipts remain failures, never success.
- No real installer or native lifecycle has been exercised; user explicitly reserved
  that testing. Production behaviour still requires parent's critical review.

Validation (no live requests)

```
node --experimental-strip-types --test tests/update-controller.test.mjs tests/update-card.test.mjs tests/update-tracker.test.mjs
npm run build
```

React tests render the real action row with injected state/actions; controller tests
use only fake ports. No DOM interaction harness exists in this repo: keyboard focus
transfer is implemented but still needs an interactive accessibility check with a
fake port. No actual download/install/restart, native build, release or version bump
was performed.

## Frontend FAIL remediation (2026-10-29, uncommitted)

Production `updatePort` now delegates protocol mapping to `createUpdatePort` in
`src/services/updateAdapter.ts`. Node tests inject all dependencies into that same
factory; no download, HTTP endpoint, IPC or OS lifecycle is executed. Terminal jobs
never map to installing or join as active downloads. Healthy receipts must match
actual native getVersion; acknowledgements are keyed by transaction/version/outcome
in localStorage with an in-memory fallback if storage is denied. Terminal metadata
still clears a previously active job when another window acknowledged the receipt.
If persistent storage is unavailable, acknowledgement cannot survive a new process;
version matching still prevents success for an old/different binary.

Only structured error codes are interpreted. Coarse download_failed stays general;
prepare_failed is an installation failure, never a permissions diagnosis. Unsupported
capability is separate from unavailable observation, expired/drifted selections and
missing verification metadata. Native exceptions/conflicts reobserve the real job;
only observed failed jobs produce an installation failure. Native still returns
coarse string errors in the current contract: unknown strings remain neutral when
reobservation cannot establish the actual outcome. Native recovery now binds the published install_update recovery command. An unresolved recovery receipt remains actionable across reloads and is never acknowledged away.

Cancellation failure retains the observed stage and displays a persistent action
error; subsequent unchanged polls do not erase it. Explicitly cancelled job IDs
cannot resurrect stale ready state. The app observer uses a Web Lock owner and
BroadcastChannel observations where available, with 1s active / 15s idle scheduling,
serialized requests and explicit action wakeups. Older webviews without both APIs
fall back to one adaptive observer per window; backend remains the single job owner.
The scheduler is fake-time tested. Cross-webview lock election/delivery still needs
an interactive packaged-app check; it has not been exercised against real windows.

`createAudioDraftOwner` is used by CreateMeetingWizard for recorded and imported
files. AudioRecorder transfers the existing capture lease with the file, synchronously;
recorder unmount does not own that lease anymore. Upload acceptance releases the
matching draft; upload rejection retains it. Replacement/discard and wizard disposal
release their own entries. Pending recorder stop retains the fence through final
chunks/native finalization. Backend/native final checks remain authoritative.
The integration regression connects this production owner to the actual controller;
React action markup is rendered with fake state. There is no mounted DOM harness:
real focus movement, lifecycle event timing and screen-reader announcements still
require interactive verification. Existing Mini finalization tests remain included.

The card retains neutral 32px buttons, 2px byte progress, reserved helper space,
separate persistent polite/assertive regions, quarter-step progress announcements,
and focus transfer to cancel/status. Recovery/unknown state never claims that the
previous version was restored or that the current version is unchanged. The busy
copy covers retained audio drafts as well as capture. No OS-security attributes or
backup policy are changed by this frontend patch.

Regression evidence (temporary logs outside the repository):

- `/tmp/steppe-updater-red.log`: original controller cancel-failure, initial outage
  and completed/reset/poll regressions fail before the controller fixes. The new
  adapter module did not yet exist in that initial run.
- `/tmp/steppe-adapter-defect-red.log`: after extraction, reinstating the original
  completed-stage and Russian-regex defects in the production factory makes both
  raw-wire regressions fail (completed maps to installing; download_failed becomes
  disk_full). The corrected production source was restored before green checks.
- `/tmp/steppe-draft-red.log`: missing ownership seam before implementation.
- `/tmp/steppe-poll-red.log`: explicit idle wake regression fails before scheduler fix.

Final fake-only validation:

```
node --experimental-strip-types --test tests/*.test.mjs
# 101 tests, 101 pass, 0 fail
npm run build
# pass; existing dependency directives/chunk-size warnings remain
git diff --check
# pass
```

The earlier updater suite had **26**, not 42 tests. The expanded updater-only suite now has **42 passing tests**. Do not infer mounted component,
OS UI or native transaction coverage from these Node counts. Backend/native and
build-script changes in this shared working directory belong to the concurrently
running parent/other child; this implementation child did not edit them. No commits,
pushes, version changes or real updater actions were performed.

Critical design self-review checked recovery wording, cancel error visibility,
progress/live regions, neutral styling and removal of false unsupported states.
An independent critical design review remains required by the parent before accepting
this patch. No children were launched because this task explicitly prohibited them.

Parent fixes after second Opus review (2026-10-29)
------------------------------------------------

Saved failed jobs are dismissible on Check/channel change and before retry. The
adapter persists dismissal by job ID; obsolete failures after an equal or newer
manual installation are suppressed. Retry uses the currently discovered release,
not the failed job target. Idle polls no longer clear start errors with no job.
Unresolved recovery is never acknowledged as a one-time notification: the card
keeps the native “Восстановить предыдущую версию” action until it resolves.
Mini caption shutdown no longer releases capture ownership; reset keeps the fence
through final chunks, durable upload and session cancellation, including failures.

Red evidence: /tmp/steppe-updater-round2-red.log. The new real-adapter/controller
regressions failed before these corrections. Fake-only tests include stale errors,
new channel/release retries, manual installation, persistent recovery, idle-poll
error retention and failed Mini reset uploads. No live updater actions were run.
