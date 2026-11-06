/**
 * Queue consumers. A command that keeps failing stops after `retries` redeliveries and moves to
 * the dead-letter queue, where the event router records it and blocks its Task. The dead-letter
 * consumer has no dead-letter queue of its own (that would be a loop). Index commands have no Task
 * to block: the indexer records its own last failed delivery.
 */
export type ConsumerSpec = {
  queue: string;
  service: "agents" | "integration" | "event-router" | "indexer";
  batch: number;
  retries: number;
  deadLetter: boolean;
  concurrency: number;
};

export const QUEUE_CONSUMERS: ConsumerSpec[] = [
  {
    queue: "agent-wakeups",
    service: "agents",
    batch: 10,
    retries: 3,
    deadLetter: true,
    concurrency: 2,
  },
  {
    queue: "integration",
    service: "integration",
    batch: 10,
    retries: 3,
    deadLetter: true,
    concurrency: 2,
  },
  {
    queue: "verification",
    service: "integration",
    batch: 5,
    retries: 3,
    deadLetter: true,
    concurrency: 2,
  },
  {
    queue: "release",
    service: "integration",
    batch: 5,
    retries: 3,
    deadLetter: true,
    concurrency: 2,
  },
  {
    queue: "dead-letter",
    service: "event-router",
    batch: 5,
    retries: 5,
    deadLetter: false,
    concurrency: 1,
  },
  {
    queue: "indexing",
    service: "indexer",
    batch: 1,
    retries: 3,
    deadLetter: false,
    concurrency: 1,
  },
];
