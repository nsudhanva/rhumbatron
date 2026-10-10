# Module: observability

Status: placeholder. It has no resources.

Observability is configured elsewhere today:

- Workers Logs: the `observability` block in `modules/worker` and `modules/durable-worker`
  (`logs_head_sampling_rate`, default 1).
- Analytics Engine: `METRICS` bindings to the dataset `rhumbatron_metrics_<env>` in the env roots.
  The dataset is created on first write.
