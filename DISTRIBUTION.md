# Steppe Meeting 0.2.0-beta.7 — beta distribution

Target: Apple Silicon (`arm64` / `aarch64`), macOS 15 or later. Intel builds are not produced by this packaging configuration.

## Beta.7: automatic-update capability detection

The shipping frontend now receives the validated macOS ARM64 build target before
Vite compiles it. The update button and release-check platform/architecture use
one shared identity. Earlier beta.4–beta.6 builds compiled without this metadata,
so they displayed only manual download even when an installable update existed.
GitHub release metadata cannot repair JavaScript already installed in those apps.

**Beta.2–beta.6 (and earlier builds) require a one-time manual DMG installation of
beta.7.** After that bootstrap, supported packaged main windows can use Settings →
Updates → Beta → Check → «Обновить до …» for future releases. Browser, development,
Mini, unsupported platform and unsupported architecture guards remain enforced.

The build gate runs the actual shipping index/assets with read-only fake release
metadata and native IPC, checks the real primary button and nonempty query target,
and tests restricted variants. All transport is intercepted; it never downloads
or installs an update. A second audit recovers the tested shipping JavaScript from
the signed executable, byte-for-byte, before packaging. These controlled checks do
not claim a real-user install or interactive native button test.

## STT recommendations carried forward from beta.6

Beta.6 adds evidence-backed labels to the local STT model catalog:

- GigaAM INT8: «Лучший в целом» and «Лучший для казахского» on supported devices.
- Standard Whisper Large v3 Turbo: «Лучший для русского» and «Для рус + англ», with an always-visible «английский не сравнивали» caveat.
- Wav2Vec2 RU/KK: a CPU alternative for Russian and Kazakh.

«Как определено» discloses the 30.10.2026 M5 Pro test, WER results and the small
FLEURS corpus: 12 Russian phrases, 12 Kazakh phrases and three artificial RU+KK
splices. These splices do not establish live language-switching quality. English
was not tested. Speed refers only to the tested implementations on that Mac.
Unsupported GigaAM has no actionable winner labels. Untested variants, including
INT4, INT6 and Whisper Small, have no winner claim; the old Small recommendation
is removed. Custom Whisper quality warnings remain visible.

No model is selected automatically. Defaults, inference routing and user settings
are unchanged. No private recordings or benchmark artifacts accompany the build.

## Functionality carried forward from beta.4

The primary «Обновить до X» action downloads a SHA256-pinned GitHub Releases DMG,
checks the bundle, installs it atomically and restarts the app. Stable and beta
channels are supported. Active capture, generation and retained audio drafts block
installation; interrupted work requires a fresh install click. Verified health
receipts confirm completion; explicit recovery restores the previous bundle.
Manual download remains available for unsupported builds, verification failures
and installation errors, including a non-writable Applications directory.

Beta.4–beta.6 also require the one-time manual bootstrap described above; their
shipping capability gate was broken. Beta.2/beta.3 and earlier remain manual too. Application Support, recordings, model weights and
STT/LLM preferences are preserved; no global default model changes are included.
The build remains ad-hoc signed and is not notarized. Real user button interaction,
keyboard focus and screen-reader behavior remain for interactive verification.

## Build and verify

Build prerequisites: Node, project dependencies installed with `pnpm install --frozen-lockfile`, Rust stable, Xcode 26.3 with the macOS 26.2 SDK selected, and Python 3 with pip. The native Metal dependency uses newer SDK declarations behind runtime availability guards; the app's minimum deployment target remains macOS 15. These are developer prerequisites; recipients do not need them. CI selects Xcode through `DEVELOPER_DIR`.

```sh
python3 scripts/build-beta.py
```

This prepares pinned official runtime downloads and hash-checked PyPI wheels, builds the current frontend and release executable, checks configured resources byte-for-byte, verifies the code signature, and runs cold/warm backend startup with a fresh `STEPPE_DATA_DIR`, working directory `/`, a system-only incoming PATH, and a private port. It then creates and read-only mounts the DMG to verify the app and `/Applications` link. It never installs, publishes, tags, or touches an existing backend. It stops only the build process group that it starts if compilation stops producing output for three minutes.

The script applies `src-tauri/tauri.beta.conf.json` on top of the standard Tauri configuration. Runtime resources are scoped to this release overlay so `tauri dev` does not require downloading portable runtime inputs. A raw `tauri build` without this overlay is not the distributable beta workflow.

Only a successful final `VERIFIED LOCAL BETA` message establishes a distributable build. In GitHub Actions this message describes verification on the macOS ARM64 runner, not on the release coordinator's Mac. The `Build macOS beta` workflow also requires the source tests, native backend lifecycle tests, the shipping frontend button/query/embedded-JavaScript gates and the isolated packaged updater handoff/recovery gate to pass before uploading `steppe-beta-aarch64`. Expected build outputs:

```text
build/release-0.2.0-beta.7-aarch64/
  Steppe-Meeting_0.2.0-beta.7_aarch64.app
  Steppe-Meeting_0.2.0-beta.7_aarch64.dmg
  SHA256SUMS
  app-content-manifest.json
  build-info.json
  stt-codec-smoke.json
  DISTRIBUTION.md
```

The `aarch64` token lets the beta update tracker identify the DMG. `build-info.json` records the Git HEAD, hashes of production source inputs, exact frontend assets and the runtime manifest, including uncommitted source changes. Build and test logs remain under `build/`. The app bundle directory has a per-file SHA-256 manifest; the DMG has the single-file checksum in `SHA256SUMS`.

The CI download contains the DMG, source/app manifests, the actual STT codec/repair test receipt, `SHA256SUMS` and this document. Before publication, check that `build-info.json` identifies the approved final commit and verify the downloaded DMG against `SHA256SUMS`. Keep the successful run URL with the release review. Downloading and checking a CI artifact locally does not establish local native UI or Quit verification.

Additional checks, using an existing development environment:

```sh
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
node --experimental-strip-types --test tests/*.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib backend::tests --locked
python3 scripts/smoke-bundled-runtime.py --app 'src-tauri/target/release/bundle/macos/Steppe Meeting.app'
```

The backend smoke checks the actual packaged server and its owned process shutdown. It does not prove the native application's Quit lifecycle or visual UI. Native testing must use a temporary release bundle, a private port other than 8008 and isolated user data; do not stop a real server or launch the installed app to make a test pass. React tests cover Stop; frontend asset hashes identify the compiled input. Existing debug app bundles and an installed older app are not release evidence.

## Bundled runtime and network behavior

- CPython **3.12.16**, official Astral python-build-standalone release **20261026**; `uv` **0.13.6**, official Astral release. Archive URLs and SHA-256 values are pinned in `scripts/runtime-sources.json`. The original uv vendor signature is preserved. CPython and dependency licenses remain in their archives/wheels; uv licenses accompany the executable.
- Core dependencies are locked in `backend/requirements-macos-arm64.lock`, with hashes. The versions match the development environment used for the backend regression suite. Only platform-compatible binary wheels are bundled, with no source builds on the recipient's machine.
- The signed app contains backend code, one standard DOCX template, portable runtime archives and core wheels. It contains no developer venv, meetings database, recordings, credentials, model weights, private test fixtures or model runtime packages such as Torch.
- Release backend selection never falls back to the compile-time checkout. Its health identity includes the exact resource path, app version and bundled runtime marker; an old server at the same path cannot impersonate a new version.
- First launch extracts Python and creates a venv in `~/Library/Application Support/Steppe Meeting/runtime/<manifest-id>/`. Core setup uses bundled `uv`, `--offline`, `--no-index`, `--no-python-downloads` and hash verification. It writes no files inside `.app`. An incomplete/damaged runtime produces a readable startup failure and a log path; there is no external Python fallback or false ready status.
- A different runtime manifest creates a new environment. Model weights in user data remain separate; model-specific Python dependencies may need installation again after such an update.
- The shared codec profile is **faster-whisper 1.2.1 + PyAV 18.1.0** for every STT engine. PyAV 19 removed `metadata_errors` from `av.open`, which faster-whisper 1.2.1 still calls. Status checks validate versions and cache a short synthetic decode in a fresh subprocess. An incompatible or broken environment is not Ready and offers «Установить среду». That action reinstalls the compatible profile without deleting model weights, other engine dependencies or user configuration. A profile change alone does not change the core runtime ID; existing beta.1 environments therefore need this explicit UI repair. Status polling never runs an installer.
- STT environments and weights are installed only by the existing model-specific UI actions and require network access. The backend PATH starts with bundled `uv`, so these actions work without a user installation of uv. The build runs an explicit, network-enabled STT dependency test in a separate temporary environment using this same packaged Python, uv, core wheels and production installer. It installs the exact shared profile, decodes synthetic WAV and WebM/Opus, reproduces the PyAV 19 failure and repairs it. No model weights or live LLM calls are involved; no optional dependencies or caches are added to the app.
- CLI providers still require the corresponding CLI and user login. HTTP providers require their configured service. These services are independent of backend readiness. Models, optional dependencies and external services can have their own platform requirements.

## Sharing and signing

The local build uses ad-hoc signing (`signingIdentity: "-"`), not Developer ID distribution signing or notarization. This verifies bundle integrity locally but does not establish trust for downloaded copies on another Mac. Gatekeeper may block a shared DMG/app; do not claim seamless Finder installation for recipients or disable security protections. A public beta needs a reviewed signing/notarization or explicit trusted-user handoff policy from the release owner.

Once reviewed and approved for sharing, send the versioned DMG with `SHA256SUMS`. The user opens the DMG and copies **Steppe Meeting.app** via its **Applications** link. Quit the old app before replacing it. No terminal bootstrap, Node, Python, uv, model weights or user database should accompany the DMG. The beta GitHub release and installation are separate actions owned by the release coordinator.

## Local blocker observed on 2026-10-28

The local release attempt compiled the current frontend but newly executed Rust dependency build scripts stalled before `main`, in `_dyld_start`, including a fresh release-profile `objc2-exception-helper`. Newly downloaded CPython and the vendor-signed uv also timed out on `--version`; an isolated cold-start smoke never reached health. New native dependency libraries also stalled during `dlopen` in a test against extracted wheels. No security controls were disabled or quarantine attributes removed. The own build/test processes were stopped after bounded diagnostics.

No new verified `.app` or `.dmg` resulted from that local attempt. The GitHub Actions workflow runs the same build and resource/runtime/DMG checks on a separate macOS ARM64 host. A successful CI run and its downloaded artifact provide that build's evidence; they do not remove the local execution blocker. The prepared local runtime resources are inputs, not evidence of a working install. Do not redistribute stale debug bundles.
