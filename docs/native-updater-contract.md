# Native updater contract (helper protocol 1)

Implementation scope: Python backend, Tauri IPC, installer helper. Frontend adapter
must bind this contract before the button is enabled. All HTTP URLs below are under
`/api/v1/system/updates`. No endpoint accepts an asset URL, local path or script.

## Selection and download

`GET /api/v1/system/updates?current_version=…&channel=stable|beta&platform=darwin&arch=aarch64`
retains the tracker response and adds `installable`, `selection_id` or
`install_error`. Selection pins repository `almatkai/Steppe-Meeting`, release ID,
asset ID, channel, version, architecture, byte size and GitHub SHA256 digest.
Selections expire after 15 minutes. Client version does not authorize a downgrade:
installation compares against the version supplied by the native launcher.

`POST /download {"selection_id":"…"}` returns a job. Repeating the same selection
while active returns the same job; another selection receives HTTP 409.
`GET /job` observes the shared state in every window. `POST /cancel {"job_id":"…"}`
cancels download/ready/deferred and removes the owned partial/ready DMG.

Job fields: `job_id`, `selection_id`, `version`, `channel`, `stage`, `bytes`,
`total_bytes`, `megabytes` (decimal MB), `percent`, `cancellable`, `error` (Russian,
nonsecret), `retry`, `busy`, `autoEligible`. Only `idle` omits job fields.

Stages:

| Stage | Meaning | Adapter stage |
| --- | --- | --- |
| idle | No job | idle |
| downloading | Streaming and hashing bytes | downloading |
| ready | Digest and size verified, no installation begun | ready |
| deferred | Busy; needs a fresh explicit install click | ready |
| preparing | Native-authorized mount/copy/verification | installing |
| awaiting_exit | Helper prepared; Tauri exits via its lifecycle | installing |
| replacing / backup_created | Transaction in progress | installing |
| restarting | Updated bundle launched; health not confirmed | installing |
| completed | New version + transaction receipt + bundled backend ready | healthy receipt |
| cancelled | Owned download removed | cancelled |
| error | No successful install; may redownload with fresh selection | failed |
| rolled_back | Old bundle restored and launch requested | rolled_back receipt |
| recovery_required | Backup retained; needs recovery intervention | recovery_required receipt |

`autoEligible` is a server-owned activity-history latch within a job and is
informational to the frontend. Ready always waits for an explicit
«Обновить и перезапустить» click. No poll, mount, restore or download-completion
path calls `install_update`. A healthy receipt is never inferred from HTTP 200
or `awaiting_exit`.
Map backend busy reason `request` to frontend `processing`.

## Native authority and capture coordination

`invoke('set_update_capture_busy', {busy:true})` must complete **before** starting
browser microphone/capture in each webview, including wizard/Mini. Call with false
only after capture and pending chunks settle. A shared native window set blocks
installation, and native recording itself checks the same fence.

`invoke('install_update', {jobId})` is accepted only by the bundled local main
webview in release builds. It checks native capture, serializes installation,
then sends a private per-process capability to the owned backend. Public loopback
HTTP alone receives 403 from `/native-install`. Other windows observe the job.
Downloading and applying an update are separate user actions; an explicit click
in an authorized main window is required to start installation.

Ready always waits for an explicit «Обновить и перезапустить» click, including
when there was no activity during download and `autoEligible` remains true.
A deferred result does not schedule installation after work completes.
No separate owner token is required by native IPC; the frontend controller's
owner lease is local download ownership, not an installation credential.

Critical preparation fences new backend writes (including complete streamed
response lifetime) and native capture. Generation/transcription DB state,
generation task ownership and current chunk/request ownership independently block
installation. All providers and STT implementation paths are retained.

## Transaction and packaging

Helper version 1 is copied to the private job directory. It executes with the
already extracted portable CPython, outside the replaceable bundle; it imports
only the standard library. Existing resource globs and build source audit include
both updater modules automatically. No version bump or publishing is required.

DMG mounts readonly without browse/autoopen. The helper verifies bundle ID,
product/version/executable, arm64, deep strict codesign, build source hashes and
runtime manifest/file hashes. Only the current trusted helper executes during
preparation. Stage and backup are adjacent to the current bundle. Permission
failures return an error without requesting elevation.

The helper holds an OS file lock and waits at most 60 seconds for both exact
native/backend PID + executable/start identities to exit. It never signals these
or other application processes. Each rename is journaled to state, the previous
bundle remains recoverable, and safe failures roll back before relaunch. A live
unhealthy new instance is never overwritten: the state becomes recovery_required.
Health must match version, bundle backend path, bundled runtime, transaction ID
and a running app instance. LaunchServices receives the transaction environment
receipt explicitly. App Support audio, models, settings, runtime and private cache
are never replaced or reset.

## Backend/native review round (2026-10-29)

The following details are the current transaction and recovery behavior.

Capture ownership is native and process local: each browser webview acquires the
native capture fence before capture, releases it after pending chunks settle;
window destruction and WebKit process termination release only that webview's
entry. RecorderState remains independently busy throughout native stop/file
finalization. Both start and install acquire capture_windows before RecorderState;
window cleanup never clears RecorderState. Backend chunk locks and complete write
response lifetimes block installation. Durable finalized=0 transcript checkpoints
are recovery data, not evidence of a live microphone, and are never rewritten by
the updater. DB transcribing/generating state and generation task ownership still
block independently.

Replacement uses macOS renamex_np(RENAME_SWAP), with no two-rename fallback.
Unsupported API/filesystem and permissions fail closed. The staged tree is fsynced
before exchange; journal replacement and bundle directory mutations fsync their
parent directory. At the exchange cut the installed path names either old or new;
the old bundle lives at the stage path until moved to the backup path. Journal
records device/inode identities for both bundles. Crash-cut tests exercise actual
macOS filesystem exchange; these are process interruption tests, not physical
power-cycle certification. Apple syscall reference:
https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2

Restart observation removes owned download.part/ready.dmg from abandoned
never-installed jobs and returns idle (normal cancelled stays cancelled). Missing
or malformed state/journal is handled without failing every poll. A helper is
active only when its exact PID/start/executable identity matches AND the OS lock
is held. Active pending health stays restarting/awaiting_exit. With the helper
gone, this bundled backend may complete its own transaction only when native
launch receipt, version, native process identity, installed inode and full bundle
verification match. It can normalize the old-stage name to backup in that case.
Startup metadata never launches an installer. Polling is currently the trigger
for this reconciliation; there is no separate boot daemon.

Explicit recovery uses the existing main-window install_update(jobId) IPC for a
recovery_required job. It starts the trusted external helper, exits through Tauri,
waits for the exact owned native/backend processes to exit, verifies the previous
bundle and atomically exchanges it back. Other running app instances prevent
recovery. Frontend must label this action “Восстановить предыдущую версию” and must
never invoke it automatically. The resulting receipt is rolled_back. This action
still needs frontend binding/review; no frontend file was changed in this round.

A healthy transaction retains its immediate previous version. A later healthy
transaction may remove older owned backups/stages whose recorded inode matches,
and old owned DMGs. Cleanup failures do not roll back healthy software. Unresolved
or malformed journals are preserved rather than guessed away. No quarantine
attributes are removed, Gatekeeper bypassed, or elevation dialog invented.
Non-writable installation directories can require manual installation.

Additional job field: error_code (nullable). Current codes: download_failed,
prepare_failed, journal_invalid, interrupted, recovery_required, recovery_failed,
rolled_back; transaction failures also use error/rolled_back/recovery_required.
HTTP 409 keeps detail and adds error_code=invalid_update_request. Adapters should
use localized text for codes; never display raw native IO/JSON exceptions.
preparing continues to map to installing. No existing stage was removed.

## Isolated verification and remaining coverage

Run from this checkout:

```
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_update*.py' -q
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_release_updates.py' -q
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml updater::tests -- --nocapture
```

The Rust cfg(test)-only isolated_native_fixture_flow entry point executes the
Python macOS fixture. It is absent from production. The fixture creates its own
arm64 executable with clang, ad-hoc signs a temporary Steppe bundle, creates a real
DMG, mounts readonly, verifies/copies/verifies, detaches, and rejects altered
resources/wrong version. It also launches the headless temporary executable with
LaunchServices open -n --env and verifies its isolated STEPPE_DATA_DIR receipt.
Download tests use httpx.MockTransport and temporary data; no runtime environment
variable can override production download trust roots or native install paths.
Transaction/helper subprocess tests exercise real temporary filesystem exchange
with injected verifier/health callbacks. No private audio fixture is included.

Limits: this is a compile-time test seam, not an enabled dev install IPC or a
complete packaged Tauri → backend → external helper → new bundled backend health
end-to-end test. Full product health after relaunch, native recovery helper launch
and exit handoff, and genuine WKWebView crash/native capture overlap need a CI
packaged fixture harness before shipping. No installed product was run or updated.

Executed locally in this round: updater suite 41 passed (including the real DMG
and LaunchServices fixture), release suite 23 passed, streaming recording suite 10
passed; Rust updater tests 4 passed and cargo check --tests passed. git diff --check
passed. Red reproduction: executing the review-input update_busy function against
the new isolated historical-session regression produced the expected failure
('recording' unexpectedly present); the implemented function passes that test.
No frontend tests were run by this backend child. The temp helper tests use
injected health, so they do not certify the full packaged health handoff.

Remaining backend scope for parent review: cleanup intentionally preserves
unverifiable/missing-journal staging rather than deleting an unidentified bundle;
there is not yet a bounded garbage collector for those exceptional artifacts.
The test seam exercises Rust's fixture runner and real macOS tools, but does not
allow or exercise development install_update IPC. Do not treat these checks as
approval to ship or as completion of the full product integration test gate.

## Packaged fixture gate (implementation follow-up)

`python3 scripts/smoke-packaged-updater.py --app 'src-tauri/target/release/bundle/macos/Steppe Meeting.app'`
now runs after the distributable build and before artifact upload in
`.github/workflows/beta-build.yml`. Failure blocks upload. Diagnostics are
`build/packaged-updater-smoke.log`; only successful completion writes
`build/packaged-updater-smoke.json` with `result=PASS`. A prior receipt is removed
before attempting the gate. CI must execute this command after parent integrates
the frontend review; source review or unit tests do not substitute for its PASS.

The harness compiles the explicit `packaged-updater-fixture` feature twice, with
compile-time TEMP root, private port and distinct native version constants. Both
executables use the reviewed backend source and the baseline's bundled runtime;
the native version passed to health, bundle plist and build manifest agree. No
checkout version file changes. Native binaries are copied into owned TEMP bundles
and ad-hoc signed, then an actual candidate DMG is created. Fixture HTML is
embedded by the build configuration; production frontend files are not edited.
The fixture-only backend wrapper seeds a SHA256-pinned local candidate as ready
and provides controlled busy work. This deliberately does not exercise GitHub
network download; existing pinned-download tests cover selection/streaming.
The helper copy changes only its health transport port. Production URLs and
installation authority are unchanged. No environment variable can activate these
native overrides in an ordinary binary. Shipping build entry rejects fixture
flags/environment and resource audit rejects the fixture binary marker. The
production `updater_fixture` command is an unconditional denial stub. Ordinary
production binaries reject `--steppe-updater-fixture*` with exit code 2.

Required receipt assertions: native capture deferred without exit, real active
generation deferred without exit, missing/invalid capability HTTP 403, non-main
webview IPC denied, permission failure without exit, concurrent native install
coalesced, real private native HTTP handoff, real external helper startup and
exact native/backend exit wait, readonly DMG staging, atomic exchange, a new
native process with matching bundled-backend version/path/transaction receipt,
then explicit native IPC recovery through the external helper and old backend
relaunch. The harness uses existing production health and recovery functions,
not injected success callbacks. The fixture additionally navigates the main webview to its private HTTP origin
and requires install IPC to be unavailable or rejected before returning to the
bundled page. Rust authority tests cover the debug-build denial as well. Real browser-button interaction remains the user's later test.
Receipt includes executable/DMG hashes, native/backend PIDs, health paths,
versions, duration, permission mode, busy assertions and rollback result.
Only exact executable paths inside the created temporary root are eligible for
cleanup signals. The build command owns its own process group and timeout. No
installed app, user runtime/data or port 8008 is contacted. Gatekeeper and
quarantine are unchanged.

Contract delta: a concurrent `install_update` while the first invocation is
pending returns `stage=preparing, cancellable=false` without a second HTTP request
or exit request. The first invocation remains authoritative; this is not a
successful installation receipt.

Storage policy: normal healthy transactions retain their immediate previous
bundle and retire older verified owned backups. Any unidentified staging tree, or
backup lacking a matching completed/rolled-back journal and inode, blocks new staging before
another bundle can be created. Unknown trees are preserved for manual review;
retries cannot multiply them. There is no automatic deletion of unidentified
bundles. A verified rolled-back candidate permits one retry; a later healthy transaction
removes that known failed copy. Two consecutive retained failed candidates block
further downloads pending manual review, so repeated failures remain bounded.
The same guard runs before downloading, preventing new DMGs from accumulating
behind unresolved staging. Small job journals can remain; this is a bound on accumulated application
payloads, not a promise of zero metadata growth.

Local follow-up execution: the packaged fixture completed a real authenticated
Tauri → backend → external helper → replacement → new bundled backend health
handoff and explicit recovery to the old bundle. The local baseline was an
existing beta.3 CI DMG copied readonly into an owned temporary directory; current
backend source and freshly compiled native executables supplied the code under
test. The fixture deliberately forces recovery_required after real healthy
completion to exercise the explicit recovery command; it does not claim an
end-to-end automatic rollback caused by a damaged incoming backend. Both helpers
run the actual production transaction/recovery functions. Initial failing attempts
caught the missing Cargo custom-protocol build option, the canonical bare
`tauri://localhost` origin rejection, and an incorrect fixture recovery-state
setup; none wrote a PASS receipt. Production authority now accepts that exact
bare bundled root in addition to its existing paths; lookalike hosts remain denied.

Latest Python updater regression run: 47 passed. Rust updater suite: 5 passed,
including the real DMG/LaunchServices fixture; both normal and fixture-feature
cargo check passed. Native formatting, Python compilation, fixture JS syntax and
git diff whitespace checks passed. The final packaged receipt records the
machine assertions; CI execution itself has not been triggered or observed in
this child. No real installed app, installed runtime, real DB/settings, or port
8008 was accessed, quit, killed, installed or updated. No commit, push, version
file bump, release or deployment was performed.
