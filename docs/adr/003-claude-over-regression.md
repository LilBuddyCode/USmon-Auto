# ADR-003: Claude API over linear regression for predictive reorder

**Status:** Accepted
**Date:** Day 2 of sprint

## Context

We need to predict, per SKU, how many days until stockout. Inputs include recent daily usage, current stock on hand, incoming orders, lead time per supplier, and seasonality (cases per week pattern).

Two ML approaches considered:

1. **Linear regression / time-series statistical model** — fit usage rate, project to zero stock
2. **Claude API call** — pass the recent context, ask for prediction + reasoning

## Decision

Use **Claude API with structured prompt** as the primary prediction path. Keep a simple statistical-projection function in `lib/predict-fallback.ts` as a sanity check + offline-mode fallback.

## Status

Accepted.

## Consequences

**Positive:**
- Explainability. Claude returns reasoning per prediction ("usage rate trending up over last 14 days, current stock + incoming covers ~5 days at current rate, recommending reorder of N units"). The reasoning text goes into a JSONB column and appears in the dashboard tooltip. Customer trust comes from being able to ask "why."
- Handles edge cases naturally. Holiday weeks, supplier delays, unusual case volume spikes — a regression model needs explicit features for these. Claude reads the context.
- Tunable via prompt, not retraining. If the predictions are off, we edit the prompt, not gather more training data + retrain.
- Demonstrates AI engineering for the FDE portfolio. Hiring managers see "wrote prompts, ran evals, validated against reality" rather than "trained sklearn model."
- Cost-tractable. Per-SKU prediction at Sonnet 4.6 costs ~$0.003. 200 SKUs × daily = ~$0.60/day = ~$18/month. Trivial.

**Negative:**
- Variance. Same input can produce slightly different output across calls (temperature 0 helps but doesn't eliminate). Mitigation: cache by input hash for 24 hours; pin temperature to 0; eval suite catches drift.
- API dependency. If Anthropic is down, our prediction breaks. Fallback regression function handles this gracefully (logs to a `predictions.degraded` table).
- Latency. Each Claude call is 1-3 seconds. For 200 SKUs that's 200-600 sec sequential. Mitigation: batched calls (10 SKUs per prompt) AND background-worker queue (predictions don't need to be instant; nightly batch is fine).

**Considered alternatives:**

- **Linear regression:** Cheap, fast, deterministic. Limited handling of context. Kept as fallback in `lib/predict-fallback.ts`.
- **Time-series ARIMA:** More sophisticated than linear regression but still doesn't handle qualitative context (a supplier delay, a known holiday). Rejected.
- **Fine-tuned smaller model:** Overkill for 14 days. Cost of fine-tuning >> Claude API cost at this scale.
- **Heuristic rules:** Hand-coded thresholds. Brittle. Used as part of fallback only.

## Eval discipline

Per ADR-001 of the sprint plan, the eval suite tests:

- Precision on stockout prediction (when we predict stockout, did it happen?)
- Recall (of actual stockouts, how many did we catch?)
- MAE on days-until-stockout
- False positive rate
- Drift detection over time

Eval runs on every commit via GitHub Actions. Regression in any metric blocks merge.

## Related

- ADR-002: Postgres for the prediction-payload JSONB column
- The Eval Suite in the sprint plan
