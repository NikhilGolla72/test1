# AWS CLI Manual Deploy Runbook (No CloudFormation)

This runbook is for deploying Sensei-Observability&Evaluation in account 831974769837 when CloudFormation CreateStack and CreateChangeSet permissions are unavailable.

Goal:
- Create and wire backend resources directly with AWS CLI.
- Keep naming convention: test-us1-sensei-{name}.
- Avoid breaking sandbox and avoid accidental deletes.

Scope covered:
- Calculator Lambda
- Observability-Evaluation Lambda
- WebSocket API Gateway v2 + routes + integrations + stage
- Lambda invoke permissions for API Gateway
- CloudWatch log groups used by analyzer
- Frontend environment values to switch

Out of scope in this runbook:
- Cognito creation (already done via Terraform)
- AgentCore runtime creation (assumed existing: sensei-calculatoragent)

-------------------------------------------------------------------------------
1) Preconditions and Safety Gates
-------------------------------------------------------------------------------

1. Verify account before every deploy command:
aws sts get-caller-identity --query Account --output text
Expected: 831974769837

2. Verify region:
aws configure get region
Expected: us-east-1

3. Confirm naming convention inputs:
- API name: test-us1-sensei-observability-evaluation-ws
- Stage name: test
- Calculator lambda name: test-us1-sensei-calculator-fn
- Observability-Evaluation lambda name: test-us1-sensei-observability-evaluation-fn

4. Required permissions for this method:
- lambda:CreateFunction, lambda:UpdateFunctionCode, lambda:UpdateFunctionConfiguration, lambda:AddPermission, lambda:GetFunction
- apigateway:POST, apigateway:GET, apigateway:PUT for ApiGatewayV2 resources
- iam:PassRole for lambda execution role(s)
- logs:CreateLogGroup, logs:DescribeLogGroups
- s3:GetObject if artifacts are pulled from S3

-------------------------------------------------------------------------------
2) Required Inputs
-------------------------------------------------------------------------------

Set these values first in your shell:
- ACCOUNT_ID = 831974769837
- REGION = us-east-1
- STAGE = test
- CALC_LAMBDA = test-us1-sensei-calculator-fn
- OBS_EVAL_LAMBDA = test-us1-sensei-observability-evaluation-fn
- API_NAME = test-us1-sensei-observability-evaluation-ws
- AGENTCORE_RUNTIME_ID = sensei-calculatoragent
- AGENTCORE_RUNTIME_ARN = arn:aws:bedrock-agentcore:us-east-1:831974769837:runtime/sensei-calculatoragent
- ANALYZER_MODEL_ID = arn:aws:bedrock:us-east-1:831974769837:inference-profile/global.anthropic.claude-sonnet-4-6
- RUNTIME_LOG_GROUP = /aws/bedrock-agentcore/runtimes/test-us1-sensei-calculatoragent-DEFAULT
- RUNTIME_LOG_STREAM = agent-traces
- EVALUATOR_LOG_GROUP = /aws/bedrock-agentcore/evaluations/results/test-us1-sensei-evaluator
- ANALYZER_AUDIT_LOG_GROUP = /aws/test-us1-sensei/observability-evaluation-websocket
- ANALYZER_AUDIT_LOG_STREAM = observability-evaluation-websocket
- LOOKBACK_HOURS = 720

Also define lambda execution role ARNs:
- CALC_EXEC_ROLE_ARN = role ARN with execute-api manage connections and bedrock-agentcore invoke permissions
- OBS_EVAL_EXEC_ROLE_ARN = role ARN with execute-api manage connections, logs read, xray read, and bedrock invoke permissions

If role creation is blocked, ask platform team to pre-provision both roles and provide ARNs.

-------------------------------------------------------------------------------
3) Build Artifacts From Repo
-------------------------------------------------------------------------------

1. Build the project artifacts:
sam build

2. Package calculator and observability-evaluation code directories from build output:
- Calculator source directory: .aws-sam/build/CalculatorFunction
- Observability-Evaluation source directory: .aws-sam/build/AnalyzerFunction

Create zip files:
- calculator.zip from .aws-sam/build/CalculatorFunction
- observability-evaluation.zip from .aws-sam/build/AnalyzerFunction

-------------------------------------------------------------------------------
4) Create or Update Lambda Functions
-------------------------------------------------------------------------------

For each lambda, use this pattern:
- If function exists: update code and configuration.
- If function does not exist: create function.

Calculator function configuration:
- Handler: app.lambda_handler
- Runtime: python3.12
- Timeout: 60
- Memory: 512
- Environment:
  AGENTCORE_RUNTIME_ID
  AGENTCORE_RUNTIME_ARN

Observability-Evaluation function configuration:
- Handler: app.lambda_handler
- Runtime: python3.12
- Timeout: 45
- Memory: 1024
- Environment:
  RUNTIME_LOG_GROUP
  RUNTIME_LOG_STREAM
  EVALUATOR_LOG_GROUP
  ANALYZER_MODEL_ID
  DEFAULT_ANALYSIS_LOOKBACK_HOURS
  ANALYZER_REQUEST_BUDGET_SECONDS=40
  ANALYZER_AUDIT_LOG_GROUP
  ANALYZER_AUDIT_LOG_STREAM

After create or update, capture function ARNs:
- CALC_LAMBDA_ARN
- OBS_EVAL_LAMBDA_ARN

-------------------------------------------------------------------------------
5) Create or Reuse WebSocket API
-------------------------------------------------------------------------------

1. Create API (if missing):
- ProtocolType = WEBSOCKET
- RouteSelectionExpression = $request.body.action
- Name = test-us1-sensei-observability-evaluation-ws

2. Capture API_ID.

3. Create integrations (AWS_PROXY) for both lambdas and capture integration IDs:
- CALC_INTEGRATION_ID
- OBS_EVAL_INTEGRATION_ID

4. Create routes:
- $connect -> calculator integration
- $disconnect -> calculator integration
- $default -> calculator integration
- calculator -> calculator integration
- observability_evaluation -> observability-evaluation integration

5. Create stage named test with auto deploy enabled.

6. Construct websocket URL:
wss://{API_ID}.execute-api.us-east-1.amazonaws.com/test

-------------------------------------------------------------------------------
6) Grant API Gateway Permission To Invoke Lambdas
-------------------------------------------------------------------------------

Add lambda permissions for API Gateway principal apigateway.amazonaws.com on both functions.
Use source ARN pattern:
arn:aws:execute-api:us-east-1:831974769837:{API_ID}/*

Create two permission statements:
- calculator-apigw-invoke
- observability-evaluation-apigw-invoke

-------------------------------------------------------------------------------
7) Ensure Log Groups Exist
-------------------------------------------------------------------------------

Ensure these log groups exist (create if missing):
- /aws/bedrock-agentcore/runtimes/test-us1-sensei-calculatoragent-DEFAULT
- /aws/bedrock-agentcore/evaluations/results/test-us1-sensei-evaluator
- /aws/test-us1-sensei/observability-evaluation-websocket

Do not delete existing log groups.

-------------------------------------------------------------------------------
8) Frontend Wiring
-------------------------------------------------------------------------------

Use the new Cognito outputs already created:
- VITE_COGNITO_USER_POOL_ID = us-east-1_42yIFGs6r
- VITE_COGNITO_USER_POOL_CLIENT_ID = 39c8ah5vrgr440gd5jamnukfqt

Set websocket URL from API_ID and stage:
- VITE_WEBSOCKET_API_URL = wss://{API_ID}.execute-api.us-east-1.amazonaws.com/test

Keep:
- VITE_AWS_REGION = us-east-1
- VITE_DEFAULT_ANALYSIS_LOOKBACK_HOURS = 720

-------------------------------------------------------------------------------
9) Validation Checklist (Must Pass)
-------------------------------------------------------------------------------

1. Frontend login works with new Cognito pool and client.
2. WebSocket connects to test stage URL.
3. Calculator mode returns response.
4. Observability-Evaluation mode returns response.
5. Observability-Evaluation can read runtime and evaluator logs.
6. Audit events appear in /aws/test-us1-sensei/observability-evaluation-websocket.

If any item fails, stop cutover and fix before proceeding.

-------------------------------------------------------------------------------
10) Rollback Plan
-------------------------------------------------------------------------------

1. Do not delete old sandbox resources.
2. Revert frontend environment to previous known working values.
3. Keep new test resources for debugging until successful redeploy.
4. Only clean up test resources after stable validation window.

-------------------------------------------------------------------------------
11) Practical Notes
-------------------------------------------------------------------------------

- This method is operationally valid but less maintainable than CloudFormation or SAM deployment.
- Once permissions are available, move back to IaC deployment to prevent drift.
- Keep a record of all created resource IDs and ARNs for repeatability.
