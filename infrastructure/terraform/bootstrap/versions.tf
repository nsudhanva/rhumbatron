terraform {
  required_version = ">= 1.16.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
  }

  # The first apply used local state because the bucket did not exist yet. The state then moved
  # here with `terraform init -migrate-state`. See ../README.md.
  backend "s3" {
    key                         = "bootstrap/terraform.tfstate"
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
