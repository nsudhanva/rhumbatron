terraform {
  required_version = ">= 1.16.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
    # Reads K2 stream IDs back from the temporary K2 adapter (ADR 0006).
    external = {
      source  = "hashicorp/external"
      version = "~> 2.4"
    }
  }

  # R2 remote state. Supply bucket and endpoint with `terraform init -backend-config=backend.hcl`.
  # Supply R2 credentials with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
  backend "s3" {
    key                         = "prod/terraform.tfstate"
    region                      = "auto"
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
