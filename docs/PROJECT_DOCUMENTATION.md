# Sensei Analyzer System - Project Documentation

## Overview
**Sensei Analyzer** is a real-time log analysis system that uses LLM-powered intent detection to intelligently analyze agent execution traces, evaluator metrics, and X-Ray distributed trace data. Users ask natural language questions, and the system automatically determines what data to fetch and how to present it.

---

## Core Technologies

| Component | Technology |
|-----------|-----------|
| **Frontend** | TypeScript + React 18 + Vite + Amplify Authenticator |
| **Backend** | AWS Lambda (Python 3.12) + API Gateway WebSocket |
| **AI Models** | Claude Sonnet 4.6 via Bedrock Inference Profile |
| **Data Sources** | CloudWatch Logs Insights, X-Ray, Custom Evaluator Logs |
| **Auth** | AWS Cognito (username/email support) |
| **Infrastructure** | AWS SAM (CloudFormation) |
| **Observability** | CloudWatch Logs + Audit Trail |

---

## Project Structure

```
agentcore-react/
├── frontend/                          # React UI application
│   ├── src/
│   │   ├── components/chat/           # ChatComposer, MessageList, AnalyzerHelpPanel
│   │   ├── pages/                     # AssistantChatPage, AnalyzerChatPage
│   │   ├── hooks/useChat.ts           # WebSocket state management
│   │   ├── services/                  # websocketClient, auth (Cognito)
│   │   ├── types/chat.ts              # TypeScript interfaces
│   │   └── config.ts                  # Environment & Amplify setup
│
├── backend/
│   ├── functions/
│   │   ├── analyzer/app.py            # Core analysis pipeline (~1750 lines)
│   │   └── calculator/app.py          # AgentCore runtime wrapper
│   └── template.yaml                  # SAM/CloudFormation definition
│
├── my_agent1.py                       # AgentCore pricing agent
├── samconfig.toml                     # SAM deployment config
└── .bedrock_agentcore.yaml            # AgentCore metadata

```

---

## System Architecture

### Two-Mode Chat System

**1. Assistant Mode (Calculator)**
- Invokes AgentCore runtime directly
- Handles pricing queries, general assistance
- Simple pass-through to runtime

**2. Analyzer Mode (Core System)**
- LLM-driven intent detection
- Adaptive data collection
- Real-time analysis with audit logging

### Request Flow

```
User Question
    ↓
[Intent Detection] → Detect: summary|listing|deep_dive|comparison|anomaly|other
    ↓
[Data Collection] → Fetch runtime, evaluator, X-Ray (based on intent)
    ↓
[Context Slicing] → Package data payload by intent (compact or detailed)
    ↓
[Model Invocation] → Claude analyzes with prepared context
    ↓
[Chunked Response] → Stream response over WebSocket to frontend
    ↓
[Audit Trail] → Log all decisions in CloudWatch for demo visibility
```

---

## Key Features

### 1. **Intent Detection (LLM-Powered)**
- Semantic classification of user questions
- 6 intent types: `summary`, `listing`, `comparison`, `deep_dive`, `anomaly`, `other`
- Supports vague, conversational, non-technical requests
- Retry pass for ambiguous cases

### 2. **Adaptive Data Collection**
- **Listings**: Skip evaluator (speed), use compact rows
- **Deep Dive/Anomaly**: Fetch X-Ray for segment-level detail
- **Summary**: Sample top 20 sessions
- All fetches bounded by query limits (max 5000 events)

### 3. **Context Slicing**
Different payloads sent to Claude based on intent:
- **listing + session_ids** → `[session_rows]` only
- **listing + trace_ids** → `[trace_rows]` only
- **summary** → `[session_rows + top 20]`
- **other** → `[full sessions objects with details]`

### 4. **Pagination with Continuation Tokens**
- Large results split into pages (30-45 rows/page)
- Base64-encoded state preserves question, plan, offset
- User can fetch next page without re-running analysis

### 5. **Audit Logging**
Real-time visibility into system decisions:
- `request_received` → user question + session
- `plan_inferred` → detected intent + entities
- `data_collection_strategy_selected` → which sources will be fetched
- `context_sent_to_model` → what keys reached Claude
- `analysis_step_before_model_invoke` → comprehensive pre-answer summary
- `response_sent` → final answer + continuation token

---

## Models & Prompts

### LLM Models
- **Planning Model**: Claude Sonnet 4.6 (intent detection, 320 tokens max)
- **Analysis Model**: Claude Sonnet 4.6 (final answer, dynamic budget)

### Key Prompts

#### 1. **Intent Detection Prompt**
Instructs Claude to classify user intent and extract entities:
```
Input: "give me a short report for nikhil"
Output: {
  "intent_type": "summary",
  "data_scope": "user_window",
  "lookback_hours": 720,
  "detail_level": "low",
  "user_names": ["nikhil"],
  ...
}
```

#### 2. **Analysis Answer Prompt**
Instructs Claude to respond from context data, handle listings, and suggest prompts:
```
Input context: {
  "analysis_request": {...},
  "window": {...},
  "session_rows": [...],
  "users_all": [...]
}
Output: Natural language analysis + suggestions for follow-ups
```

---

## Sample Queries to Try

### Summary Requests
- "give me a short report for nikhil"
- "what's the overall performance this week?"
- "summarize errors for user alice"

### Listing Requests
- "list out all session ids"
- "show me all trace ids for user bob"
- "give me more info about sessions for alice"

### Deep Dive Requests
- "compare sessions for user alice vs bob"
- "deep dive into trace-id <ID> - why was it slow?"
- "find anomalies in the last 48 hours"

### Contextual Follow-ups
- "show me more" (continues previous listing with next page)
- "explain that trace" (references prior trace from analysis)

---

## Time Budgets & Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Lambda Timeout | 22 seconds | CloudWatch query + model invoke + WebSocket response |
| Max Query Results | 5,000 events | Runtime + evaluator events per query |
| Max Token Budget | 20,000 tokens | Prompt + context + answer combined |
| WebSocket Payload | 30 KB | Response chunks to frontend |
| Continuation Token | 4 KB max | Prevents WebSocket frame overload |
| Context Truncation | 42,000 chars | Fallback when payload exceeds tokens |

---

## Deployment

### Build & Deploy
```bash
# Frontend
cd frontend && npm run build

# Backend
sam build
sam deploy
```

### Environment Variables (Lambda)
```
RUNTIME_LOG_GROUP=<CloudWatch log group for agent traces>
EVALUATOR_LOG_GROUP=<CloudWatch log group for evaluator metrics>
ANALYZER_MODEL_ID=arn:aws:bedrock:us-east-1:636052469006:inference-profile/global.anthropic.claude-sonnet-4-6
DEFAULT_ANALYSIS_LOOKBACK_HOURS=720
ANALYZER_REQUEST_BUDGET_SECONDS=22
```

## AWS Resources In Use

- AgentCore runtime id: my_agent1-EuvQcG3t0u
- AgentCore runtime arn: arn:aws:bedrock-agentcore:us-east-1:636052469006:runtime/my_agent1-EuvQcG3t0u
- Evaluator run family: evaluation_quick_start_1773400924069
- Runtime log group: /aws/bedrock-agentcore/runtimes/my_agent1-EuvQcG3t0u-DEFAULT
- Runtime log stream filter used by analyzer: agent-traces
- Evaluator log group: /aws/bedrock-agentcore/evaluations/results/evaluation_quick_start_1773400924069-RMD3JBHdQM
- Analyzer audit log group: /aws/sensei/analyzer-websocket
- Analyzer audit log stream: analyser-websocket
- Price catalog bucket: my-agent1-price-catalog-636052469006-us-east-1

---

## Audit Log Visibility

All analysis decisions are logged to CloudWatch at:
```
Log Group: /aws/sensei/analyzer-websocket
Log Stream: analyser-websocket
```

Example audit entry:
```json
{
  "ts": "2026-04-07T12:00:00Z",
  "stage": "data_collection_strategy_selected",
  "request_id": "req-abc123",
  "fields": {
    "intent_type": "listing",
    "will_fetch_evaluator": false,
    "will_fetch_xray": false,
    "detail_level": "medium"
  }
}
```

---

## Code Quality

✅ **Clean**
- 49 active functions (no dead code)
- Intent-driven data slicing (DRY principle)
- Bounded parameters (100-item limits, token budgets)
- Error handling with graceful fallbacks

⚠️ **Known Minor Issues**
- 3 utility functions duplicated in calc/analyzer lambdas (refactor opportunity)
- Context payload can reach ~11K tokens for large datasets

---

## Next Steps / Roadmap

1. **Extract Shared Utilities** → `backend/functions/shared_utils.py`
2. **Add Caching Layer** → Redis for frequent user queries
3. **Multi-Model Support** → Switch between Claude/Sonnet/Haiku by intent
4. **Custom Metrics** → Extensible scoring framework for evaluator
5. **Trace Comparison** → Side-by-side X-Ray walkthrough diffs

---

## Support & Questions

For detailed code-level explanations, see:
- **Intent Detection**: [analyzer/app.py](backend/functions/analyzer/app.py#L587) (`_infer_analysis_plan`)
- **Data Collection**: [analyzer/app.py](backend/functions/analyzer/app.py#L1178) (`_is_listing_intent`)
- **Context Slicing**: [analyzer/app.py](backend/functions/analyzer/app.py#L1072) (`_context_for_model_prompt`)
- **Audit Logging**: [analyzer/app.py](backend/functions/analyzer/app.py#L87) (`_audit`)

---

**Last Updated**: April 7, 2026  
**System Status**: Production-Ready ✅
