# DubFlow Phase 4E — Optional Visual Lip-Sync Design

Date: 2026-09-06
Status: Approved direction; written for review

## 1. Goal

Add an optional visual lip-sync subsystem after dubbed audio has been generated and timing-qualified, without making the core dubbing/export path depend on any one visual synthesis provider.

Lip-sync must be fail-closed: the UI may expose the control only when a provider is actually configured and qualified. Standard dubbed export remains available regardless of lip-sync availability.

## 2. Dependency on Phase 4D and existing pipeline

Phase 4E starts only after the normal dubbed-audio path is stable. It consumes the final source video plus the already-qualified dubbed audio result; it does not own translation, TTS, diarization or stem separation.

Phase 4D separation is not mandatory for every lip-sync job, but when a `preserve_background` export is selected, Phase 4E must consume the audio composition produced by that export path rather than reimplementing audio mixing.

## 3. Provider boundary

Introduce:

```ts
export type LipSyncInput = {
  projectId: string;
  sourceVideoObjectKey: string;
  dubbedVideoObjectKey: string;
  targetLanguage: TargetLanguage;
  exportId: string;
};

export type LipSyncResult = {
  outputObjectKey: string;
};

export interface LipSyncProvider {
  readonly id: string;
  readonly available: boolean;
  render(input: LipSyncInput): Promise<LipSyncResult>;
}
```

The provider is injected into orchestration. No route/workflow directly calls a provider-specific HTTP API.

## 4. Capability rules

The API exposes lip-sync capability separately from audio dubbing:

```json
{
  "visualLipSync": {
    "available": false,
    "provider": null
  }
}
```

When unavailable:

- UI control is disabled;
- API request asking for lip-sync returns `LIP_SYNC_UNAVAILABLE` before billable provider work;
- no fake completion state is shown.

## 5. Workflow placement

For a dubbed export with lip-sync requested:

1. complete translation/TTS/audio timing;
2. render the normal dubbed video first;
3. validate that the normal dubbed artifact exists and is project-scoped;
4. invoke `LipSyncProvider.render`;
5. validate the provider result key;
6. publish the lip-synced artifact as the export’s final visual output;
7. persist provider usage/telemetry;
8. complete the export job.

If lip-sync fails, preserve the already-rendered normal dubbed artifact for retry/fallback but keep the requested lip-sync export job failed until the user retries or chooses standard export.

## 6. Storage contract

Use immutable output keys:

- `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4` — normal dubbed artifact
- `projects/{projectId}/exports/{targetLanguage}/{exportId}.lipsync.mp4` — lip-synced artifact

Provider temporary artifacts must not be returned as canonical exports.

## 7. Data model

Export persistence gains optional fields for visual processing state:

- `lip_sync_requested`
- `lip_sync_provider`
- `lip_sync_status`
- `lip_sync_object_key`

Allowed status values:

- `not_requested`
- `queued`
- `processing`
- `completed`
- `failed`

The canonical export API returns both the standard dubbed object and the lip-sync state so the UI can offer fallback playback/download when visual synthesis fails.

## 8. Error handling

Stable errors:

- `LIP_SYNC_UNAVAILABLE`
- `LIP_SYNC_FAILED`
- `LIP_SYNC_TIMEOUT`
- `LIP_SYNC_RESPONSE_INVALID`
- `LIP_SYNC_INPUT_INVALID`

Provider raw errors are normalized. Secrets, signed provider payloads and media URLs are not returned to clients.

## 9. Idempotency and usage

Use an operation key including export id, target language, retry generation and provider.

A completed canonical lip-sync artifact is reusable. Retries must not duplicate provider usage completion when the durable artifact already exists.

Usage kind:

- `lip_sync_video_second`

Measure against the qualified source/dubbed video duration.

## 10. Security

Only project owners may request lip-sync.

Provider URLs/tokens are server-side only. Any provider webhook or polling state must be correlated to a server-generated opaque job identifier, not trusted client input.

The feature must not imply rights to manipulate third-party likenesses; it operates only on media the user is authorized to process under the same project ownership boundary as the rest of DubFlow.

## 11. UI

The export UI gains a visual-processing choice:

- Standard dubbed video
- Visual lip-sync, when available

Status must distinguish queued, processing, failed and completed. When failed, the UI offers retry and standard-export fallback rather than hiding the already-produced dubbed artifact.

## 12. Testing

Required tests:

- capability absent -> UI/API fail closed;
- provider contract validation;
- standard export path never invokes lip-sync;
- lip-sync starts only after normal dubbed artifact exists;
- invalid provider object key is rejected;
- provider failure preserves standard artifact but does not falsely complete lip-sync;
- retry reuses completed canonical artifact;
- usage completion is idempotent;
- multi-language export still isolates target-language outputs;
- Phase 4D `preserve_background` output can feed Phase 4E without duplicated audio mixing.

## 13. Deployment and qualification

Source CI and mock provider tests qualify only source behavior. Production lip-sync remains unqualified until a real configured provider processes a supported fixture from request through final downloadable output.

No provider is considered available merely because a UI control exists.

## 14. Success criteria

Phase 4E is complete when:

1. standard dubbed exports remain unchanged;
2. lip-sync is exposed only when a real provider is configured;
3. provider orchestration is isolated behind `LipSyncProvider`;
4. failures preserve a usable standard dubbed artifact;
5. retries and usage accounting are idempotent;
6. final lip-synced media is persisted under a canonical project-scoped key;
7. live provider qualification succeeds on a supported fixture before runtime status is called PASS.
