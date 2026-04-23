# Sensei Capabilities, Limitations, and Multi-Model Scaling Plan

## 1. Purpose
This document provides a detailed but practical view of:
- what the system can do today,
- what constraints exist today,
- what constraints are likely when traffic and model count grow,
- and a recommended future multi-model architecture.

This is written for engineering planning, architecture review, and team-lead level decision making.

---

## 2. Current System Snapshot

### 2.1 Product Scope
Sensei currently supports two chat experiences:
- Assistant mode: runtime-oriented assistant flow (calculator route).
- Analyzer mode: telemetry/log analysis flow (analyzer route).

### 2.2 Current Stack
- Frontend: TypeScript + React 18 + Vite + Amplify Authenticator.
- Backend: AWS Lambda (Python) behind API Gateway WebSocket routes.
- Model access: Amazon Bedrock (Claude Sonnet 4.6 inference profile).
- Data sources: CloudWatch Logs Insights, evaluator logs, optional X-Ray details.
- Infrastructure provisioning: AWS SAM/CloudFormation.

### 2.3 Current AWS Resource Context (deployment-specific)
- AgentCore runtime id: my_agent1-EuvQcG3t0u
- AgentCore runtime arn: arn:aws:bedrock-agentcore:us-east-1:636052469006:runtime/my_agent1-EuvQcG3t0u
- Runtime log group: /aws/bedrock-agentcore/runtimes/my_agent1-EuvQcG3t0u-DEFAULT
- Runtime stream filter used by analyzer: agent-traces
- Evaluator log group: /aws/bedrock-agentcore/evaluations/results/evaluation_quick_start_1773400924069-RMD3JBHdQM
- Evaluator family (base name): evaluation_quick_start_1773400924069
- Analyzer audit log group: /aws/sensei/analyzer-websocket
- Analyzer audit stream: analyser-websocket
- Data bucket used in current setup: my-agent1-price-catalog-636052469006-us-east-1

---

## 3. Current Features and Capabilities

### 3.1 Intent-Aware Analysis
Analyzer classifies incoming prompts into intent categories and plans retrieval strategy.
Current functional intent categories:
- summary
- listing
- deep_dive
- comparison
- anomaly
- other

What this enables:
- faster response for lightweight intents,
- richer context for deep-dive intents,
- better UX for natural-language, non-technical prompts.

### 3.2 Adaptive Data Collection
The analyzer dynamically decides whether to fetch:
- runtime events,
- evaluator events,
- X-Ray traces/subsegments.

Capability impact:
- avoids heavy fetches when not needed,
- improves latency for listing-style requests,
- improves quality for trace diagnostics when deep details are requested.

### 3.3 Context Shaping Before Model Call
System slices context to intent-appropriate payloads (rows vs full sessions).
This controls:
- prompt size,
- model cost,
- response quality vs speed tradeoff.

### 3.4 WebSocket Streaming and Pagination
- Response chunking keeps payloads within transport limits.
- Continuation tokens support pagination for long listings.

### 3.5 Operational Audit Trail
The analyzer emits stage-level audit logs, including:
- request_received
- plan_inferred
- data_collection_strategy_selected
- context_sent_to_model
- analysis_step_before_model_invoke
- response_sent/timeouts/exceptions

Why this matters:
- demo transparency,
- faster debugging,
- better root-cause analysis for latency/timeouts.

### 3.6 Timeout Fallback Behavior
Timeout fallbacks were added so some requests can still return deterministic outputs if model narration times out.
This increases reliability under variable model latency.

---

## 4. Current Limitations (Now)

### 4.1 Request-Path Coupling to Live Queries
The analyzer still depends on live CloudWatch query cycles at request time.
Risk:
- tail latency spikes,
- response variability,
- greater timeout probability under load.

### 4.2 Single-Path Lambda Budget Pressure
One request path currently carries:
- planning,
- data retrieval,
- merge/shape,
- model generation,
- websocket delivery,
- audit logging.

Risk:
- small latency increases in each step can accumulate into end-to-end timeout.

### 4.3 Prompt/Context Size Sensitivity
Even with bounded token logic, quality and latency are sensitive to payload size and shape.
Risk:
- inconsistent model completion time,
- occasional timeout for deep-dive narratives.

### 4.4 Partial Duplication in Utility Functions
Some websocket/helper logic exists in multiple Lambdas.
Risk:
- maintenance drift,
- duplicated bug-fix effort.

### 4.5 Operational Complexity During Spikes
Model latency from Bedrock can vary by demand and profile pressure.
Risk:
- periodic timeout bursts despite stable code.

---

## 5. Future Limitations (As Scale Increases)

When integrating more models and significantly higher data volume, the following become primary concerns.

### 5.1 Multi-Model Routing Complexity
More models means routing decisions across:
- intent,
- cost,
- latency,
- quality requirements,
- region/profile availability.

Without a routing layer, logic in one Lambda becomes brittle.

### 5.2 Cost Volatility
Different models and token footprints produce different cost profiles.
At high volume:
- poor routing can increase cost rapidly,
- retries/timeouts magnify spend.

### 5.3 Data Volume and Query Saturation
Large historical datasets increase live query times.
At scale, pure request-time query strategy leads to:
- high p95/p99 latency,
- unstable UX,
- inability to keep strict response SLOs.

### 5.4 Context Management Across Long Sessions
As conversation depth grows and multiple models are used, context consistency becomes harder.
Possible failure modes:
- contradictory responses,
- stale state usage,
- context window overflow.

### 5.5 Observability Fragmentation
With many models and services, observability can split across many logs/metrics.
Without unified tracing/correlation:
- hard incident diagnosis,
- weak governance evidence.

### 5.6 Throughput and Concurrency Limits
Higher request concurrency can stress:
- Lambda concurrency,
- Logs Insights query API quotas,
- Bedrock throughput quotas,
- websocket management calls.

---

## 6. Recommended Future Multi-Model Architecture

### 6.1 Architecture Principles
- Keep user chat latency path lean.
- Move heavy analytics and enrichment off the request path.
- Centralize model routing policy.
- Standardize event schema across all agents/models.
- Prefer precomputed summaries for common questions.

### 6.2 Proposed Logical Components

1) Ingestion Layer
- Collect runtime/evaluator/trace events continuously.
- Normalize all events to a common schema.

2) Storage Layer (hot + cold)
- Hot store for low-latency operational lookups.
- Cold store for historical analytics.

3) Summary/Aggregation Layer
- Build per-user, per-session, per-model summaries asynchronously.
- Serve common requests from precomputed materialized views.

4) Model Router (control plane)
- Select model based on intent, token budget, latency target, and cost policy.
- Support fallback model chain on timeout.

5) Analyzer Orchestrator
- Compose data context using summary-first strategy.
- Escalate to trace-level raw retrieval only when needed.

6) Response Service
- Handle chunking, continuation tokens, and deterministic fallback responses.

### 6.3 Suggested Data Stores
- DynamoDB: session/user-level hot lookup and summary objects.
- S3 + Athena: historical event lake and ad hoc analytics.
- Optional OpenSearch: fast full-text exploration across traces/prompts.

### 6.4 Standard Event Schema (Target)
Every agent/model event should include:
- tenant_id (if multi-tenant in future)
- agent_id
- model_id
- session_id
- trace_id
- request_id
- user_id / user_name
- timestamp
- intent_type
- status/error class
- latency fields
- token usage fields
- evaluator scores
- xray references

### 6.5 Model Routing Strategy (Example)
- summary/basic listing: low-latency, lower-cost model profile
- deep_dive/trace analysis: higher reasoning model profile
- timeout fallback: short deterministic response or lower-latency backup model

### 6.6 Reliability Pattern
- Primary attempt: preferred model/profile
- Secondary attempt: fallback model/profile if primary latency breaches threshold
- Final fallback: deterministic server-generated summary

This ensures user receives a response even under model degradation.

---

## 7. Scalability Plan by Phase

### Phase 1: Stabilize Current Path (Immediate)
- Keep current architecture.
- Tighten routing and fallback behavior.
- Keep audit logs at key points only.
- Add dashboard for timeout ratio and stage timing.

### Phase 2: Summary-First Read Path
- Introduce ingestion + hot summary tables.
- Use precomputed summaries for common requests.
- Reduce direct CloudWatch dependency on hot path.

### Phase 3: Multi-Model Router
- Externalize model selection policy.
- Add cost and latency-aware routing.
- Add automatic fallback chain.

### Phase 4: Enterprise Scale
- Multi-tenant isolation controls.
- Cross-region strategy for model/service resilience.
- Governance and compliance audit package.

---

## 8. Risks and Mitigations

### Risk: Bedrock latency spikes
Mitigation:
- lower max token budgets for time-sensitive intents,
- model fallback chain,
- deterministic fallback response.

### Risk: Query cost and performance degradation
Mitigation:
- summary-first architecture,
- asynchronous aggregation,
- cold/hot storage split.

### Risk: Prompt drift across models
Mitigation:
- prompt templates versioned by intent and model family,
- eval-based regression tests per prompt version.

### Risk: Data schema drift from multiple agent sources
Mitigation:
- strict event schema contract,
- ingestion validators and dead-letter handling.

### Risk: Operational blind spots
Mitigation:
- correlation ids end-to-end,
- unified metrics and tracing dashboard,
- SLO alerting (timeouts, p95 latency, fallback ratio).

---

## 9. Suggested SLOs/KPIs

Latency and reliability:
- p50 response latency
- p95 response latency
- timeout rate
- fallback response rate

Quality and usefulness:
- answer success rate (no retries)
- user follow-up correction rate
- trace deep-dive completeness score (internal rubric)

Cost and efficiency:
- cost per 1,000 requests
- average token usage by intent
- query cost by intent and timeframe

---

## 10. Implementation Recommendations (Practical)

Short term:
- Keep current logging stages.
- Keep deterministic fallback active.
- Add explicit routing guard so trace-window requests do not fall into listing flow.

Medium term:
- Build ingestion + summary tables.
- Introduce model-router module with policy config.

Long term:
- Formal multi-model control plane with A/B route policies.
- Full scale test harness with synthetic high-volume telemetry.

---

## 11. Summary for Leadership
Sensei is functionally strong today for moderate load, with good intent-aware analysis and observability. The main scalability risk is request-time coupling to live query and model generation. The recommended path is summary-first data architecture plus centralized model routing and deterministic fail-safes. This provides predictable latency, lower timeout risk, and controlled cost as models and data volume grow.

---

## 12. Related Documents
- PROJECT_DOCUMENTATION.md
- FUTURE_MULTIMODEL_ARCHITECTURE.md
- DEPLOYMENT.md
