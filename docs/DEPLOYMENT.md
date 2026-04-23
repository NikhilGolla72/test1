# Sensei Deployment Guide

## What is included

- React + TypeScript frontend with two chat pages:
  - Assistant chat (calculator runtime)
  - Analyzer chat (fleet/session analysis)
- AWS SAM backend with one WebSocket API and two Lambda functions:
  - `CalculatorFunction` for `calculator` route
  - `AnalyzerFunction` for `analyzer` route
- Cognito authentication in frontend via Amplify Authenticator

## Project layout

- `frontend/` - React app for Amplify deployment
- `backend/functions/calculator/app.py` - Calculator websocket handler
- `backend/functions/analyzer/app.py` - Analyzer websocket handler
- `template.yaml` - SAM infrastructure

## 1) Deploy backend (SAM)

```powershell
sam build
sam deploy --guided
```

Recommended guided values:

- Stack name: `sensei-backend`
- Region: `us-east-1`
- StageName: `prod`
- AgentCoreRuntimeId: `my_agent1-EuvQcG3t0u`
- AgentCoreRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:636052469006:runtime/my_agent1-EuvQcG3t0u`
- RuntimeLogGroup: `/aws/bedrock-agentcore/runtimes/my_agent1-EuvQcG3t0u-DEFAULT`
- RuntimeLogStream: `agent-traces`
- EvaluatorLogGroup: `/aws/bedrock-agentcore/evaluations/results/evaluation_quick_start_1773400924069-RMD3JBHdQM`
- AnalyzerModelId: `arn:aws:bedrock:us-east-1:636052469006:inference-profile/global.anthropic.claude-sonnet-4-6`
- DefaultAnalysisLookbackHours: `720`

After deploy, copy `WebSocketApiUrl` from SAM outputs.

## 2) Configure frontend env

Use `env-frontend.txt` values in a frontend `.env` file under `frontend/`.

Required variables:

- `VITE_AWS_REGION`
- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_USER_POOL_CLIENT_ID`
- `VITE_WEBSOCKET_API_URL`
- `VITE_DEFAULT_ANALYSIS_LOOKBACK_HOURS`

## 3) Run frontend locally

```powershell
cd frontend
npm install
npm run dev
```

## 4) Deploy frontend to Amplify

- Connect repository in AWS Amplify
- Set app root to `frontend`
- Configure environment variables from frontend `.env`
- Build command: `npm run build`
- Output directory: `dist`

## WebSocket request contract

Frontend sends:

```json
{
  "action": "calculator" | "analyzer",
  "requestId": "string",
  "sessionId": "string",
  "prompt": "string",
  "mode": "assistant" | "analyzer",
  "lookbackHours": 720,
  "idToken": "<cognito-id-token>"
}
```

Lambda responds:

```json
{
  "type": "assistant_response" | "error",
  "mode": "assistant" | "analyzer",
  "requestId": "string",
  "sessionId": "string",
  "answer": "string"
}
```

## Notes

- The analyzer lambda builds a merged multi-session JSON from runtime, evaluator, and optional X-Ray data before calling Bedrock.
- The calculator lambda attempts AgentCore runtime invocation using `bedrock-agentcore-runtime`.
- If your account uses a different runtime API shape, update `_invoke_runtime` in `backend/functions/calculator/app.py` accordingly.
