# Per-attempt generation selection

Meeting generation can use another configured provider/model without saving AI
settings or transcribing audio again. This contract applies to protocol, both
translations, summary and custom-template generation in one owned job.

## Options

`GET /api/v1/meetings/{id}/generation-options` returns:

```json
{
  "default": {"mode": "cli", "provider": "opencode", "model": "provider/model#variant"},
  "providers": [
    {"mode": "api", "provider": "api", "label": "API из настроек", "model": "saved-model", "requires_model": true, "supports_models": true},
    {"mode": "cli", "provider": "codex", "label": "Codex CLI", "model": "", "requires_model": false, "supports_models": false}
  ],
  "last_attempt": null
}
```

The real list includes the saved API profile and all four CLIs: OpenCode, Codex,
Claude and Antigravity. `supports_models` is true for API, OpenCode and
Antigravity. This is a discovery capability, not a successful authentication or
inference check. Paths, URLs and credentials are not returned. The options route
does not validate the current model: a broken saved model must not prevent the
user from selecting another provider.

`GET /api/v1/meetings/{id}/generation-models?mode=cli&provider=opencode` uses the
provider's saved executable path. For the configured API use `mode=api` and omit
`provider` or send `provider=api`. It returns the existing CLI model-list shape:
`{provider, models:[{id,name?,provider,free}], pricing_available, fetched_at,
error?}`. API costs are unknown (`free:null`), never guessed. Discovery makes no
inference request. Errors and empty lists must leave manual model entry usable.

## Start or retry

`POST /api/v1/meetings/{id}/generate` still accepts no body to use saved settings.
An optional body selects only this attempt:

```json
{"mode":"cli","provider":"codex","model":"chosen-model"}
```

```json
{"mode":"api","model":"chosen-api-model"}
```

Only `mode`, `provider` and `model` are accepted. Extra fields, including paths,
URLs and credentials, return 422 before the meeting status or owned job changes.
The API route always uses its one saved URL/key; there are no invented additional
HTTP profiles. CLI paths come from saved per-provider settings. Omitting `model`
uses that provider's saved model. An explicit empty model means the CLI's default
only for Codex, Claude and Antigravity. API and OpenCode require a nonempty model;
OpenCode preserves the exact `provider/model#variant` identifier. Unknown login
status is not a rejection before generation.

Accepted responses include `generation_attempt`:

```json
{
  "meeting_id":"meeting-id",
  "status":"generating",
  "generation_attempt": {
    "id":"attempt-uuid","started_at":"UTC timestamp",
    "mode":"cli","provider":"codex","model":"chosen-model"
  }
}
```

The same nonsecret identity is persisted in the meeting and exposed by its normal
GET response; options return it as `last_attempt`. API identity uses
`provider:"api"`. Empty CLI model names explicitly represent the CLI default.
This identity means attempted, not authenticated, completed or ready.

## Ownership and failure semantics

The destination is copied into an immutable ContextVar before creating the owned
generation job. Concurrent meetings and independent chats do not share the
override. Changing global AI settings while a job runs cannot switch its later
stages. Every meeting job uses only its selected provider; legacy OpenAI fallback
is disabled within this context. Outside meeting jobs existing chat behavior is
unchanged.

The transcript, audio and prior completed result set remain intact on provider
failure or cancellation. New results are still committed atomically only after
all stages succeed. Existing Stop ownership, cleanup and stale-write fencing are
unchanged. No automatic provider/model substitution or generation retry is added.

Automatic Mini/post-transcription handoffs also capture saved settings. Invalid
saved settings leave the saved/finalized transcript in `error` with
`Не удалось начать генерацию: …`; they do not leave an unowned `generating` state.
The user can then make an explicit valid generation request without another STT
pass. Repeated Mini completion does not implicitly resubmit the generation.
