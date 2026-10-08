# Step 1 uses local state. After the state bucket exists, migrate this state to R2.
# See ../README.md.
terraform {
  required_version = ">= 1.16.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
  }
}
