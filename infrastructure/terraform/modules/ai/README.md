# Module: ai

Owns:

- The AI Gateway (`rhumbatron-models-<env>`) that proxies OpenRouter. See ADR 0007.
- Model-related non-secret configuration.

The OpenRouter key is a Worker secret, never a gateway setting.
