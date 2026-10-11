-- 0023_drop_release_targets: a release moves the live app pointer only (ADR 0020). No code reads
-- `release_targets` or `releases.build_uuid`. Release rows stay.

DROP TABLE release_targets;
ALTER TABLE releases DROP COLUMN build_uuid;
