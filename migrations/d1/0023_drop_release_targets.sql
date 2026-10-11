-- 0023_drop_release_targets: releases go to the live app only (ADR 0020). The Workers Builds
-- release path (ADR 0018) is gone: no code reads `release_targets` or `releases.build_uuid`.
-- Release rows and their history stay.

DROP TABLE release_targets;
ALTER TABLE releases DROP COLUMN build_uuid;
