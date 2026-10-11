-- 0027_project_settings: the default budget of a Project's new Changes (Project Settings page).
-- NULL means the built-in default (3 USD). `PATCH /v1/projects/:projectId` sets it, 0.5 to 25 USD.

ALTER TABLE projects ADD COLUMN default_budget_usd REAL;
