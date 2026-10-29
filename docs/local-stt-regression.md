Local recording regression
==========================

Final full audio from both Mini and the wizard is cached by the shared upload
endpoint, before acknowledgement. One SHA256-addressed immutable copy survives
meeting deletion. Retries reuse that copy. Cache failures return an error; retry
saving. Nothing is uploaded. Cache lives in `Steppe Meeting/stt-regression` under
Application Support (or STEPPE_DATA_DIR), directories 0700, audio 0400, JSON 0600.
Delete this folder explicitly to remove retained regression data. It is private
user data; never add audio, manifests, reports or transcripts to Git/CI.

Use a Python environment with the selected installed local model's dependencies:

```
python scripts/replay-recordings.py cache --audio /absolute/recording.webm --source-id meeting-id --model whisper-turbo-kaz-rus-v1
python scripts/replay-recordings.py replay --suite /absolute/private-suite.json
```

The suite is a nonempty JSON array. Each case requires `sha256`, `model`, and
`anchors`: objects with `start`, `end` (seconds), `pattern` (lowercase regex) and
`provenance` (human listening or independent recognizer plus crop/time/source).
Optional: `language`, `streaming`, `min_duration`. Include independently checked
beginning, middle and end anchors for every >=60s case. Do not use the tested
model's output as a golden. Missing/corrupt inputs, empty suites and absent
anchors fail loudly. No downloads or network inference are allowed. Reports
remain private and contain samples/duration, VAD timeline, actual segments,
anchor verdicts, timing, model weight hashes, adapter hashes, runtime and options.
A passing anchor suite tests those phrases, not every word's accuracy.

The latest local case reproduces missing beginning and ending lexical anchors
in the production adapter. An experimental per-VAD-interval decoder recovered
the beginning but still failed the ending and distorted other short words; it
was rejected. Do not treat duration, a segment spanning the file, or patched
option tests as proof of complete speech. The existing model-specific prior-text
conditioning mitigation is preserved. A general completeness fix remains open.

Explicit comparisons (never change persisted app settings)
---------------------------------------------------------

```
python scripts/replay-recordings.py replay --suite /absolute/private-suite.json --model wav2vec2-rukk
python scripts/replay-recordings.py replay --suite /absolute/private-suite.json --model medium --language ru --model-dir /absolute/existing/medium/weights
```

The override is opt-in, validates existing model files and never downloads weights.
Use the Python runtime containing that engine's dependencies. Installed weights
alone do not imply runtime readiness (model dependencies require explicit installation). Reports distinguish requested and tested models and record
engine-specific options. Run the minimal suite separately as well.

The current converted Kazakh/Russian Whisper artifact still fails the original
three-file suite and the six-second minimal case. Bounded non-clipping gain,
no-timestamp decoding, disabling VAD, phrase crops and dequantized float32 CPU
inference did not establish a generally passing configuration. Some combinations
recover individual phrases and lose others. Do not ship these as a fix. This does
not prove that the original unquantized model has the same defect.

Wav2Vec2-rukk with existing weights, auto device, multi language and the checkout
Torch runtime passes the stored three-file anchors and minimal case. It is an
explicit alternative to evaluate, not an automatic fallback. The anchors were
originally derived using that recognizer: its passing score is circular evidence
for its own accuracy, not independent confirmation or a complete golden.
Already cached standard Whisper Base/Medium with Russian selected recover the
latest beginning but fail other unchanged anchors. No model is certified as
complete. Human verification remains necessary before claiming the requested
fullness fix; the selected Whisper model now exposes this known limitation in
catalog/status and Settings without changing the selection or runtime readiness.

Synthetic 82-second tests lock down the replay gate: full duration and broad
segment timestamps cannot hide absent beginning/middle/end text, and text at the
wrong time fails. They test the gate, not recognizer accuracy. The actual audio
replays remain opt-in and are required evidence for any future inference fix.

Independent prewritten speech fixture
------------------------------------

```
backend/.venv/bin/python scripts/generate-stt-fixture.py
backend/.venv/bin/python scripts/replay-recordings.py replay --suite "$HOME/Library/Application Support/Steppe Meeting/stt-regression/independent-milena-v2/suite.json"
```

The generator writes original Russian prose and fixed thresholds before ASR,
uses only the installed macOS Milena voice (`say -r 135`), and retains the audio
in the private content-addressed cache. No voice/model downloads. Subsequent
runs reuse and verify the cached input. Three independently synthesized prose
sections contain distinct phrases at the beginning, middle and end; their
windows come from decoded synthesis sample counts. Only two 0.3s section gaps
are added; no padding to reach the duration threshold. The fixture is synthetic
speech, not a human recording or a human accuracy certificate.

The actual decoded fixture is 96.215125 seconds / 1,539,442 samples at 16kHz,
with 186 normalized reference tokens. Before recognition the limits were fixed:
WER <= 20%, ordered token recall >= 85%, all three time-bound anchors, valid
chronological segments and >=60 seconds decoded audio. Normalization folds case,
ё/е and punctuation; recall uses longest common subsequence, WER uses full
Levenshtein distance. Reordering and insertion/deletion failures are not hidden
by an unordered word bag. Full-reference metrics supplement lexical anchors.

Observed production-adapter results:

* Wav2Vec2-rukk, multi, auto (CPU TorchScript), checkout Torch 2.14.1:
  13 edits / 186 words, WER 6.989%, recall 93.011%, anchors 3/3, timing PASS.
* Selected custom Whisper, multi, unchanged production options:
  55 edits / 186 words, WER 29.570%, recall 71.505%, anchors 1/3, FAIL.
* Actual `_install_packages('wav2vec2-rukk', ..., False)` in a fresh temporary
  venv created from the installed portable Python 3.12.16 succeeded in 92s.
  The official registry resolved Torch 2.15.0, faster-whisper 1.2.1, av 18.1.0,
  CTranslate2 4.8.4. Its decode/import readiness probe and actual independent
  speech replay passed with the same metrics. Only existing weights were read.
  The owned venv was removed after evidence capture. This temporary test preceded the separately authorized installed-app setup described below.

Private `independent-milena-v2/` contains specification, provenance, suite,
installer results and real-anchor audit. ASR reports remain under `reports/`.
Original `suite-all.json` and its ten strict anchors remain unchanged. Reusing
previous Base/Medium production-adapter outputs independently corroborates
8/10 anchors (both models agree on the same eight). The latest recording's end
and the 65s recording's middle remain circular for Wav2Vec2. Cross-model
agreement does not prove human accuracy or complete transcripts; the audit
records `human_verified: false` for every anchor. The selected Whisper remains
unfixed. The user subsequently approved Wav2Vec2-rukk and its explicit local selection.

Authorized installed-app verification (2026-10-29)
------------------------------------------------

The release coordinator installed Torch 2.15.0 through the running app's explicit
environment action, preserving faster-whisper 1.2.1 and PyAV 18.1.0. The actual
installed beta.2 production adapter and portable runtime passed the 96.215s
prewritten fixture: WER 6.989%, ordered recall 93.011%, anchors 3/3. All four
private cases passed lexical anchors; two anchors still lack independent
corroboration. The coordinator then explicitly selected local Wav2Vec2-rukk,
auto device; status was ready. LLM settings and existing audio/model files were
preserved. This is evidence for that selected alternative, not a repair of the
custom Whisper model or a certificate of complete human transcription.

Beta.3 ships the automatic cache, offline replay tools and model quality warning.
It preserves existing model selections and does not change the global default,
migrate other users or silently fall back to another engine/API. The installed
beta.2 does not yet contain the automatic cache. Private verification reports
remain outside Git and distribution artifacts.
