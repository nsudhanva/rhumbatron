-- Advisory contention is a Claim fact. Keep this predicate identical to the Claims feed query.
DROP INDEX idx_project_events_change_claims;
CREATE INDEX idx_project_events_change_claims ON project_events (change_id, seq)
  WHERE event_type IN ('claim.acquired', 'claim.renewed', 'claim.released', 'claim.expired', 'claim.contended');
