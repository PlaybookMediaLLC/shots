-- An empty audience set is an immutable global clearance revocation.
ALTER TABLE platform_evidence_clearance
    DROP CONSTRAINT "platform_evidence_clearance_audienceIds_check",
    ADD CONSTRAINT "platform_evidence_clearance_audienceIds_check"
        CHECK (jsonb_typeof("audienceIds") = 'array' AND jsonb_array_length("audienceIds") BETWEEN 0 AND 20);
