output "queues" {
  description = "Queue name and ID by purpose."
  value = {
    for key, q in cloudflare_queue.this : key => {
      name = q.queue_name
      id   = q.id
    }
  }
}
