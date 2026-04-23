# Resource Inventory

This inventory only includes resources that are directly connected to the codebase configuration and the deployment metadata we verified for Sensei-Observability&Evaluation. Items that were seen during broader AWS discovery but are not directly wired in the repo are intentionally excluded from the main list.

## Confirmed Frontend Resources

- `VITE_AWS_REGION=us-east-1` - Frontend AWS region used by the app config.
- `VITE_COGNITO_USER_POOL_ID=us-east-1_l6dPnsMxY` - Cognito user pool ID used by the frontend authenticator.
- `VITE_COGNITO_USER_POOL_CLIENT_ID=4hb4q7nat1kqbm6ehsgtq3e2op` - Cognito app client ID used by the frontend authenticator.
- `VITE_WEBSOCKET_API_URL=wss://i2c224verd.execute-api.us-east-1.amazonaws.com/prod` - WebSocket endpoint used by the frontend to talk to the hosted SAM backend.
- `VITE_DEFAULT_ANALYSIS_LOOKBACK_HOURS=720` - Default lookback window used by the analyzer UI.

## Confirmed SAM Backend Resources

- `sensei-backend` - SAM stack name used to deploy the websocket backend.
- `SenseiWebSocketApi` - WebSocket API Gateway v2 API defined in the SAM template.
- `StageName=prod` - Deployed websocket stage used by the backend URL.
- `CalculatorFunction` - Lambda for the `calculator` websocket route.
- `AnalyzerFunction` - Lambda for the `analyzer` websocket route.
- `$connect` route - WebSocket connection route wired to the calculator integration.
- `$disconnect` route - WebSocket disconnect route wired to the calculator integration.
- `$default` route - Default WebSocket route wired to the calculator integration.
- `calculator` route - WebSocket route for assistant/calculator messages.
- `analyzer` route - WebSocket route for analyzer messages.
- `WebSocketApiUrl` output - SAM output that assembles the final websocket endpoint.

## Confirmed Lambda Deployment Targets

- `arn:aws:lambda:us-east-1:636052469006:function:sensei-backend-AnalyzerFunction-IlgaHeJQAnEX` - Deployed analyzer Lambda ARN provided by you.
- `arn:aws:lambda:us-east-1:636052469006:function:sensei-backend-CalculatorFunction-h8X1wGpYns9t` - Deployed calculator Lambda ARN provided by you.

## Confirmed Backend Runtime Parameters

- `AgentCoreRuntimeId=my_agent1-EuvQcG3t0u` - Runtime ID passed into the calculator Lambda.
- `AgentCoreRuntimeArn=arn:aws:bedrock-agentcore:us-east-1:636052469006:runtime/my_agent1-EuvQcG3t0u` - Runtime ARN used for AgentCore invocation.
- `RuntimeLogGroup=/aws/bedrock-agentcore/runtimes/my_agent1-EuvQcG3t0u-DEFAULT` - CloudWatch log group used by the analyzer.
- `RuntimeLogStream=agent-traces` - Log stream filter used for runtime traces.
- `EvaluatorLogGroup=/aws/bedrock-agentcore/evaluations/results/evaluation_quick_start_1773400924069-RMD3JBHdQM` - CloudWatch log group used for evaluator data.
- `AnalyzerAuditLogGroup=/aws/sensei/analyzer-websocket` - Audit log group used by the analyzer.
- `AnalyzerAuditLogStream=analyser-websocket` - Audit log stream used by the analyzer.
- `AnalyzerModelId=arn:aws:bedrock:us-east-1:636052469006:inference-profile/global.anthropic.claude-sonnet-4-6` - Bedrock inference profile used by the analyzer.
- `DefaultAnalysisLookbackHours=720` - Default analyzer lookback configured in SAM.
- `ANALYZER_REQUEST_BUDGET_SECONDS=40` - Analyzer request budget set in the SAM function environment.

## Confirmed AgentCore / Build Resources

- `bedrock-agentcore-my_agent1` - ECR repository used for the AgentCore container image.
- `sensei-calculatoragent` - AgentCore runtime agent name for the my_agent1 calculator runtime under the new naming convention.
- `bedrock-agentcore-sensei-calculatoragent-builder` - CodeBuild project used to build the AgentCore agent image under the new naming convention.
- `bedrock-agentcore-codebuild-sources-636052469006-us-east-1` - Source bucket used by the AgentCore CodeBuild pipeline.
- `AmazonBedrockAgentCoreSDKRuntime-us-east-1-74fa9e7c17` - Execution role used by the AgentCore runtime.
- `AmazonBedrockAgentCoreSDKCodeBuild-us-east-1-74fa9e7c17` - Execution role used by the AgentCore CodeBuild project.

## Confirmed Runtime Data Dependencies

- `PRICE_BUCKET=my-agent1-price-catalog-636052469006-us-east-1` - S3 bucket read by `my_agent1.py` for the pricing catalog.
- `PRICE_KEY=pricing/catalog.json` - S3 object key read by `my_agent1.py` for the pricing catalog.

## Confirmed Code References

- `frontend/src/config.ts` - Frontend config loader that reads the `VITE_*` variables.
- `my_agent1.py` - Agent runtime entrypoint that reads `PRICE_BUCKET` and `PRICE_KEY`.
- `backend/functions/calculator/app.py` - Calculator Lambda that invokes AgentCore and sends websocket responses.
- `backend/functions/analyzer/app.py` - Analyzer Lambda that collects logs, traces, and model context.

## Explicitly Not Found in the Repo

- SSM Parameter Store parameters - No app-owned SSM parameter names were found in the codebase.
- Secrets Manager secrets - No app-owned Secrets Manager secret names were found in the codebase.

## Excluded From the Main List

- Other AWS resources discovered during broad account sweeps were excluded unless they were directly referenced by the repo configuration or the verified deployment metadata.
- Non-linked `sensei`-named resources were intentionally ignored unless they were part of the confirmed wiring above.
