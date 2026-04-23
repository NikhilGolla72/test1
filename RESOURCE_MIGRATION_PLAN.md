# Resource Migration Plan

This plan only covers resources directly connected to the codebase configuration and the verified deployment metadata for Sensei-Observability&Evaluation. Unrelated AWS resources discovered during broad account sweeps are intentionally excluded.

## 1) Confirmed Resource Mapping

| Area | Current Resource | Current Value | Dev Target | Action |
|---|---|---|---|---|
| Frontend | Region | `us-east-1` | `us-east-1` or confirmed dev region | Keep or set per dev account |
| Frontend | Cognito User Pool ID | `us-east-1_l6dPnsMxY` | New dev user pool ID | Recreate in dev, do not reuse sandbox pool |
| Frontend | Cognito App Client ID | `4hb4q7nat1kqbm6ehsgtq3e2op` | New dev app client ID | Recreate in dev, do not reuse sandbox client |
| Frontend | WebSocket API URL | `wss://i2c224verd.execute-api.us-east-1.amazonaws.com/prod` | Dev websocket URL | Update after backend deploy |
| Frontend | Default lookback | `720` | `720` or dev-approved override | Keep unless product changes |
| Backend | Stack name | `sensei-backend` | Dev stack name | Deploy a separate dev stack |
| Backend | WebSocket API | `SenseiWebSocketApi` | New dev API | Recreate from SAM |
| Backend | Stage | `prod` | Dev stage name | Use dev-safe stage, then update frontend |
| Backend | Calculator Lambda | `CalculatorFunction` | New dev Lambda | Recreate from SAM |
| Backend | Analyzer Lambda | `AnalyzerFunction` | New dev Lambda | Recreate from SAM |
| Backend | Route | `$connect` | Dev route | Keep same wiring |
| Backend | Route | `$disconnect` | Dev route | Keep same wiring |
| Backend | Route | `$default` | Dev route | Keep same wiring |
| Backend | Route | `calculator` | Dev route | Keep same wiring |
| Backend | Route | `analyzer` | Dev route | Keep same wiring |
| Lambda ARN | Analyzer function ARN | `arn:aws:lambda:us-east-1:636052469006:function:sensei-backend-AnalyzerFunction-IlgaHeJQAnEX` | Dev ARN | Replace with dev function ARN |
| Lambda ARN | Calculator function ARN | `arn:aws:lambda:us-east-1:636052469006:function:sensei-backend-CalculatorFunction-h8X1wGpYns9t` | Dev ARN | Replace with dev function ARN |
| AgentCore | Runtime ID | `my_agent1-EuvQcG3t0u` | Dev runtime ID | Recreate or point to dev runtime |
| AgentCore | Runtime ARN | `arn:aws:bedrock-agentcore:us-east-1:636052469006:runtime/my_agent1-EuvQcG3t0u` | Dev runtime ARN | Recreate or point to dev runtime |
| AgentCore | Runtime log group | `/aws/bedrock-agentcore/runtimes/my_agent1-EuvQcG3t0u-DEFAULT` | Dev log group | Recreate or update env refs |
| AgentCore | Runtime log stream | `agent-traces` | `agent-traces` | Keep same unless dev naming changes |
| AgentCore | Evaluator log group | `/aws/bedrock-agentcore/evaluations/results/evaluation_quick_start_1773400924069-RMD3JBHdQM` | Dev log group | Recreate or update env refs |
| AgentCore | Audit log group | `/aws/sensei/analyzer-websocket` | Dev audit log group | Recreate or rename for dev |
| AgentCore | Audit log stream | `analyser-websocket` | `analyser-websocket` or dev variant | Keep or update with dev naming |
| Bedrock | Analyzer model profile | `arn:aws:bedrock:us-east-1:636052469006:inference-profile/global.anthropic.claude-sonnet-4-6` | Dev model profile | Keep if available in dev account |
| AgentCore build | ECR repo | `bedrock-agentcore-my_agent1` | Dev ECR repo | Recreate in dev |
| AgentCore build | CodeBuild project | `bedrock-agentcore-my_agent1-builder` | Dev CodeBuild project | Recreate in dev |
| AgentCore build | Source bucket | `bedrock-agentcore-codebuild-sources-636052469006-us-east-1` | Dev source bucket | Recreate or repoint in dev |
| AgentCore build | Runtime execution role | `AmazonBedrockAgentCoreSDKRuntime-us-east-1-74fa9e7c17` | Dev execution role | Recreate in dev |
| AgentCore build | CodeBuild execution role | `AmazonBedrockAgentCoreSDKCodeBuild-us-east-1-74fa9e7c17` | Dev execution role | Recreate in dev |
| Runtime data | Price bucket | `my-agent1-price-catalog-636052469006-us-east-1` | Dev bucket | Recreate or copy catalog into dev |
| Runtime data | Price key | `pricing/catalog.json` | Same key or dev equivalent | Keep object path consistent if possible |

## 1.1) Dev Naming Convention

Use one consistent dev prefix across all newly created resources so the account stays readable and easy to search.

- Prefix: `test-us1-sensei-`
- Stack: `test-us1-sensei-backend`
- WebSocket API: `test-us1-sensei-websocket-api`
- Lambda: `test-us1-sensei-calculator-fn` and `test-us1-sensei-observability-evaluation-fn`
- Cognito: `test-us1-sensei-user-pool` and `test-us1-sensei-user-pool-client`
- AgentCore runtime: `test-us1-sensei-calculatoragent`
- CodeBuild: `test-us1-sensei-calculatoragent-builder`
- ECR repository: `test-us1-sensei-calculatoragent`
- S3 price bucket: `test-us1-sensei-price-catalog`
- Runtime log group: `/aws/bedrock-agentcore/runtimes/test-us1-sensei-calculatoragent-DEFAULT`
- Evaluator log group: `/aws/bedrock-agentcore/evaluations/results/test-us1-sensei-evaluator`
- Audit log group: `/aws/test-us1-sensei/analyzer-websocket`

The exact suffixes can still be adjusted for AWS naming limits, but the prefix and purpose-based naming should stay consistent across every resource.

## 2) Explicit Non-Dependencies

- No app-owned SSM Parameter Store names were found in the repo.
- No app-owned Secrets Manager secret names were found in the repo.
- Unreferenced AWS resources discovered during broad scans are excluded unless they are directly wired in the codebase or deployment metadata.

## 3) Confirmed Decisions

- Evaluator log group is active today, but the dev environment should use a new dev-scoped name such as `dev/us1-sensei-evaluator` rather than reusing the sandbox path.
- Cognito should be recreated in dev as a fresh empty user pool and app client, since that keeps the migration simpler and avoids cross-account reuse.
- `OTEL_RESOURCE_ATTRIBUTES=service.name=my_agent1` and `CHAT_RUNTIME_TIMEOUT_SECONDS=60` are runtime or local/container environment values, not SAM Lambda environment variables.
- The analyzer should keep the same Bedrock model family, `global.anthropic.claude-sonnet-4-6`, in dev unless the account cannot access that profile.

## 4) Recommended Migration Order

1. Create the dev AgentCore runtime, ECR repo, CodeBuild project, source bucket, and execution roles.
2. Deploy the SAM backend into the dev account or dev environment.
3. Verify the deployed Lambda ARNs and websocket stage URL.
4. Recreate the Cognito user pool and app client in dev.
5. Update the frontend env values to the dev Cognito IDs and dev websocket URL.
6. Copy or recreate the S3 price catalog bucket and object in dev.
7. Validate the analyzer and calculator paths end to end.
8. Cut traffic over only after websocket connect, calculator, and analyzer all pass.

## 5) Verification Checklist

- Frontend loads with valid Cognito config.
- Websocket connects to the dev SAM backend.
- Calculator route returns a normal answer.
- Analyzer route can read runtime logs and evaluator logs.
- Bedrock inference profile is reachable in the dev account.
- AgentCore runtime invocation works from the calculator Lambda.
- Price catalog is readable from S3 by `my_agent1.py`.
- No missing environment variables remain in frontend or backend.
- No SSM or Secrets Manager dependency is required for this app.

## 6) Notes

- The current websocket URL points to the hosted SAM backend at the `prod` stage.
- Do not reuse sandbox credentials or sandbox Cognito resources for dev.
- Keep any unrelated resources out of scope until they are explicitly proven to be referenced by the codebase.
- Treat Sensei-Observability&Evaluation as the project-wide label in the migration docs, and use sensei-calculatoragent for the AgentCore runtime naming convention.

## 7) Terraform Approach For Migration

- Terraform is not currently present in the repo, so it will be introduced as a dev-only provisioning layer rather than replacing the existing SAM stack immediately.
- The first Terraform scope should cover only the new dev resources that must be renamed or recreated: Cognito user pool and client, dev websocket/API wiring where applicable, S3 price catalog bucket, AgentCore runtime/build resources, and the supporting IAM roles.
- Keep the existing SAM template as the source of truth for backend behavior during the transition, then mirror the same values into Terraform variables for the dev environment.
- Use Terraform to codify the new naming convention, dev account IDs, and environment-specific ARNs so the dev setup is repeatable and does not depend on manual console setup.
- Do not import unrelated sandbox resources into Terraform unless they are directly connected to the codebase configuration and needed for the dev cutover.

## 8) Next Step

- Create the dev Terraform skeleton with variables for account ID, region, Cognito, Bedrock model ARN, AgentCore runtime identifiers, runtime log groups, evaluator log group, price bucket, and websocket stage.
- After that, wire the Terraform outputs into the frontend `.env` and validate the websocket flow end to end in dev.

## 8.1) Second Directory Pass Notes

- [docs/README.md](docs/README.md) is stale documentation with older API Gateway and Cognito variable names; it should not be used as the source of truth for migration values.
- [frontend/.env.example](frontend/.env.example) contains placeholder values only and does not add new resources.
- [frontend/src/App.tsx](frontend/src/App.tsx) still has a temporary demo auth bypass flag that should be removed or flipped after the migration.
- [frontend/dist/](frontend/dist/) and [\.aws-sam/](.aws-sam/) are generated build artifacts and do not introduce additional source-of-truth resources.

## 9) Concrete Execution Plan

### Phase 1: Build the Terraform foundation

- Create a `terraform/` folder with a dev root module and separate modules for Cognito, backend websocket/API, AgentCore runtime/build, logging, and S3 price catalog.
- Add variables for `dev_account_id`, `region`, `stage_name`, `cognito_user_pool_name`, `cognito_app_client_name`, `bedrock_model_id`, `agentcore_runtime_id`, `runtime_log_group`, `evaluator_log_group`, `audit_log_group`, `price_bucket_name`, and `price_key`.
- Add outputs for the new dev Cognito IDs, websocket URL, Lambda names/ARNs, and any runtime identifiers needed by the frontend.

### Phase 2: Provision dev resources

- Apply Terraform in the dev account to create the fresh Cognito user pool and app client.
- Provision the dev AgentCore runtime/build resources with the new naming convention.
- Create the dev S3 price catalog bucket and place `pricing/catalog.json` in it.
- Provision any dev-specific logging resources and IAM roles.

### Phase 3: Deploy backend

- Deploy the SAM backend into the dev account with dev-specific parameter values.
- Verify the deployed Lambda ARNs and websocket stage URL match the dev outputs.
- Confirm the analyzer still uses Claude Sonnet 4.6 and the same request budget behavior.

### Phase 4: Update frontend

- Replace the frontend `.env` values with the dev Cognito IDs and dev websocket URL.
- Keep `VITE_AWS_REGION=us-east-1` unless the dev account requires a different region.
- Validate that the frontend auth flow and websocket connection both succeed in dev.

### Phase 5: Validate and cut over

- Test calculator mode end to end.
- Test analyzer mode end to end.
- Check runtime logs, evaluator logs, and audit logs for expected entries.
- Only after all tests pass, treat dev as the new target configuration.

## 10) Go / No-Go Checklist

- Dev Cognito user pool exists and frontend can authenticate.
- Dev websocket URL is live and reachable.
- Dev calculator Lambda invokes AgentCore successfully.
- Dev analyzer Lambda can read runtime logs and evaluator logs.
- Dev S3 price catalog bucket contains `pricing/catalog.json`.
- Dev logging names follow the new convention.
- No SSM Parameter Store or Secrets Manager dependency was introduced.
- Frontend `.env` is updated only after backend validation succeeds.
- Sandbox remains untouched throughout the migration.
