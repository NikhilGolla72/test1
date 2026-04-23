# Future Multi-Model Architecture Plan

## Goal
Scale Sensei from 2 agents to 4-5+ agents without keeping all analytics in live CloudWatch queries.

## Current Pattern
- Each request queries live logs.
- Analyzer asks a model to summarize the result.
- WebSocket returns chat answers.
- This works now, but it gets slower and less reliable as more agents and more sessions are added.

## Current Memory Window
- Conversation memory is currently the last 12 turns.
- That is roughly 6 back-and-forth exchanges.
- Older messages are dropped from the analyzer context.

## What to Change Next

### 1. Introduce a Normalized Event Schema
Every agent should emit the same event fields:
- agent_id
- model_id
- session_id
- trace_id
- request_id
- user_id
- timestamp
- prompt
- response
- status
- latency_ms
- token usage
- error details
- xray trace references
- evaluator scores

### 2. Add a Central Ingestion Layer
Instead of querying CloudWatch directly for every user question:
- Stream all agent logs into a shared ingestion pipeline.
- Write normalized events to a storage layer.
- Keep CloudWatch for observability, not primary analytics.

Recommended storage options:
- DynamoDB for session lookup and current state
- S3 + Athena for historical analytics
- OpenSearch if you need fast full-text search and filtering

### 3. Precompute Summaries
Create async jobs that build:
- per-session summaries
- per-user summaries
- per-model summaries
- per-timeframe summaries
- trace-level summaries

This reduces work during chat time and improves response speed.

### 4. Keep WebSocket for Delivery Only
WebSocket should be used to:
- send prompts
- stream page results
- send progress messages
- return final answers

It should not be the place where heavy data collection happens.

### 5. Support Pagination and Continuations
For large result sets:
- return page 1 immediately
- include a continuation token
- auto-fetch next pages if needed
- stop when no more rows remain

### 6. Add Agent Registry
Create a registry of supported models/agents:
- calculator
- analyzer
- future models
- model-specific prompts
- model-specific log sources
- model-specific summaries

This makes adding new agents configuration-driven instead of code-heavy.

### 7. Separate Configuration from Code
Use parameterized configuration for:
- runtime log group
- runtime log stream
- evaluator log group
- model IDs
- audit log group
- audit log stream
- page size limits
- time budgets

Store these in:
- SAM parameters
- SSM Parameter Store
- environment variables for Lambdas
- frontend env only for frontend values

## Recommended Future Flow
1. Agent emits a normalized event.
2. Ingestion layer stores it.
3. Summary jobs precompute aggregations.
4. Analyzer reads summaries first.
5. Analyzer drills into raw traces only when needed.
6. WebSocket returns the answer.

## Why This Is Better
- Faster responses
- Lower chance of timeouts
- Easier to add new models
- Cleaner debugging
- Better scaling for sessions and traces
- Less dependence on live CloudWatch queries

## Practical Migration Steps
1. Keep current system running.
2. Add normalized event ingestion.
3. Add session summary tables.
4. Route analyzer to summaries first.
5. Add more agents one by one.
6. Move heavy queries out of the request path.

## Current Limits to Remember
- Analyzer memory: last 12 turns
- Current live log-query design: fine for small/medium usage
- Not ideal for many agents and long history

## Suggested Next Version
- frontend chat stays the same
- backend analyzer becomes summary-driven
- CloudWatch becomes a source, not the main query engine
- X-Ray lookups remain for deep dives
- pagination/continuation remains for long lists
