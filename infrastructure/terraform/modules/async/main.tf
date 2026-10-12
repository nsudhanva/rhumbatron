locals {
  # One Queue per purpose, never per Agent or Project.
  queues = toset([
    "agent-wakeups",
    "integration",
    "verification",
    "indexing",
    "release",
    "dead-letter",
  ])
}

resource "cloudflare_queue" "this" {
  for_each = local.queues

  account_id = var.account_id
  queue_name = "rhumbatron-${each.key}-${var.environment}"

  settings = {
    message_retention_period = var.message_retention_seconds
  }
}

# Consumers, retries, and dead-letter routing are configured with the consumer Workers.
