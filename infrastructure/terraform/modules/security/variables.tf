variable "zone_id" {
  description = "Zone ID."
  type        = string
}

variable "zone_settings" {
  description = "Zone settings to enforce, keyed by setting ID."
  type        = map(string)
}
