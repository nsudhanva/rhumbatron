# Copy to backend.hcl (Git ignores it) and fill in the account ID.
bucket    = "rhumbatron-terraform-state"
endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
