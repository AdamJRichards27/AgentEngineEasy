/**
 * Historical live-notes purge. The migration file must contain these
 * statements unchanged. Applying them removes conversation content from
 * rows whose structured outputs are already confirmed, or whose review
 * finished as a discard. It does not delete parent rows, consent rows,
 * structured drafts, approval history, or object-storage files.
 *
 * Rows that are still processing or still waiting for a person are left
 * untouched. So are finished rows that still hold a transcript or recording
 * pointer when no permitted structured output can be confirmed. Those are
 * reported by the dry-run query and are not cleared silently.
 */
export const LIVE_NOTES_PURGE_MIGRATION_ID = "0034_ae_live_notes_content_purge";

export const LIVE_NOTES_RECORDING_SHA_BACKFILL_SQL = `
UPDATE grow_call_transcriptions AS transcription
SET recording_content_sha256 = version.content_sha256
FROM document_object_versions AS version
WHERE transcription.recording_reference = version.id
  AND transcription.recording_content_sha256 IS NULL
`.trim();

export const LIVE_NOTES_CONTENT_PURGE_SQL = `
UPDATE grow_call_transcriptions AS transcription
SET
  recording_content_sha256 = COALESCE(
    transcription.recording_content_sha256,
    (
      SELECT version.content_sha256
      FROM document_object_versions AS version
      WHERE version.id = transcription.recording_reference
    )
  ),
  transcript = NULL,
  recording_reference = NULL,
  review_state = (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN item->>'itemType' = 'TRANSCRIPT' THEN jsonb_set(item, '{editedText}', 'null'::jsonb, true)
          ELSE item
        END
        ORDER BY ord
      ),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(COALESCE(transcription.review_state, '[]'::jsonb)) WITH ORDINALITY AS elems(item, ord)
  ),
  retention_audit = COALESCE(transcription.retention_audit, '{}'::jsonb) || jsonb_build_object(
    'schemaVersion', 1,
    'captureRecorded', true,
    'processingRecorded', true,
    'humanReviewRecorded', transcription.processing_state IN ('APPROVED', 'PARTIALLY_APPROVED', 'DISCARDED'),
    'transcriptCharCount', CASE WHEN transcription.transcript IS NULL THEN NULL ELSE char_length(transcription.transcript) END,
    'structuredOutputCounts', jsonb_build_object(
      'summary', CASE WHEN NULLIF(btrim(COALESCE(transcription.draft_summary, '')), '') IS NULL THEN 0 ELSE 1 END,
      'keyPoints', CASE WHEN jsonb_typeof(transcription.draft_key_points) = 'array' THEN jsonb_array_length(transcription.draft_key_points) ELSE 0 END,
      'commitments', CASE WHEN jsonb_typeof(transcription.draft_commitments) = 'array' THEN jsonb_array_length(transcription.draft_commitments) ELSE 0 END,
      'followups', CASE WHEN jsonb_typeof(transcription.draft_followups) = 'array' THEN jsonb_array_length(transcription.draft_followups) ELSE 0 END
    ),
    'purgedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'purgeMigrationId', '${LIVE_NOTES_PURGE_MIGRATION_ID}'
  ),
  updated_at = now()
WHERE
  (
    transcription.transcript IS NOT NULL
    OR transcription.recording_reference IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(transcription.review_state, '[]'::jsonb)) AS item
      WHERE item->>'itemType' = 'TRANSCRIPT'
        AND NULLIF(item->>'editedText', '') IS NOT NULL
    )
  )
  AND (
    transcription.processing_state = 'DISCARDED'
    OR (
      transcription.processing_state NOT IN ('PENDING', 'MEDIA_PROCESSING', 'TRANSCRIBING', 'AWAITING_AGENT_REVIEW')
      AND (
        EXISTS (
          SELECT 1
          FROM grow_activities AS activity
          WHERE activity.brokerage_id = transcription.brokerage_id
            AND activity.activity_type = 'call_summary'
            AND activity.source = 'grow_call_transcriptions'
            AND activity.source_id = transcription.id::text
        )
        OR NULLIF(btrim(COALESCE(transcription.draft_summary, '')), '') IS NOT NULL
        OR (jsonb_typeof(transcription.draft_key_points) = 'array' AND jsonb_array_length(transcription.draft_key_points) > 0)
        OR (jsonb_typeof(transcription.draft_commitments) = 'array' AND jsonb_array_length(transcription.draft_commitments) > 0)
        OR (jsonb_typeof(transcription.draft_followups) = 'array' AND jsonb_array_length(transcription.draft_followups) > 0)
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(transcription.review_state, '[]'::jsonb)) AS item
          WHERE item->>'itemType' IN ('SUMMARY', 'KEY_POINT', 'COMMITMENT', 'FOLLOWUP')
        )
      )
    )
  )
`.trim();

/**
 * Read-only count. Run this before applying the migration. It does not
 * update or delete anything.
 *
 * purge_structured_output_confirmed and purge_discarded are the rows the
 * migration will clear. held_* rows are left as they are.
 */
export const LIVE_NOTES_PURGE_DRY_RUN_SQL = `
SELECT classification, count(*)::int AS row_count
FROM (
  SELECT
    CASE
      WHEN NOT (
        transcript IS NOT NULL
        OR recording_reference IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(review_state, '[]'::jsonb)) AS item
          WHERE item->>'itemType' = 'TRANSCRIPT'
            AND NULLIF(item->>'editedText', '') IS NOT NULL
        )
      ) THEN 'already_clear'
      WHEN processing_state IN ('PENDING', 'MEDIA_PROCESSING', 'TRANSCRIBING') THEN 'held_in_flight'
      WHEN processing_state = 'AWAITING_AGENT_REVIEW' THEN 'held_for_review'
      WHEN processing_state = 'DISCARDED' THEN 'purge_discarded'
      WHEN processing_state NOT IN ('PENDING', 'MEDIA_PROCESSING', 'TRANSCRIBING', 'AWAITING_AGENT_REVIEW')
        AND (
          EXISTS (
            SELECT 1
            FROM grow_activities AS activity
            WHERE activity.brokerage_id = grow_call_transcriptions.brokerage_id
              AND activity.activity_type = 'call_summary'
              AND activity.source = 'grow_call_transcriptions'
              AND activity.source_id = grow_call_transcriptions.id::text
          )
          OR NULLIF(btrim(COALESCE(draft_summary, '')), '') IS NOT NULL
          OR (jsonb_typeof(draft_key_points) = 'array' AND jsonb_array_length(draft_key_points) > 0)
          OR (jsonb_typeof(draft_commitments) = 'array' AND jsonb_array_length(draft_commitments) > 0)
          OR (jsonb_typeof(draft_followups) = 'array' AND jsonb_array_length(draft_followups) > 0)
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(review_state, '[]'::jsonb)) AS item
            WHERE item->>'itemType' IN ('SUMMARY', 'KEY_POINT', 'COMMITMENT', 'FOLLOWUP')
          )
        ) THEN 'purge_structured_output_confirmed'
      ELSE 'held_unconfirmed_structured_output'
    END AS classification
  FROM grow_call_transcriptions
) AS classified
GROUP BY classification
ORDER BY classification
`.trim();
