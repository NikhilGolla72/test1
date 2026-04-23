import boto3
import json
import traceback

arn = "arn:aws:bedrock-agentcore:us-east-1:831974769837:runtime/test_us1_sensei_calculatoragent-FVeAERG4BI"
payload = {
    "prompt": "hello",
    "session_id": "diag-session-2",
    "client_request_id": "diag-2"
}

client = boto3.client("bedrock-agentcore", region_name="us-east-1")
print("Invoking:", arn)
try:
    resp = client.invoke_agent_runtime(agentRuntimeArn=arn, payload=json.dumps(payload))
    body = resp.get("response") or resp.get("body")
    if hasattr(body, "read"):
        body = body.read()
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", "replace")
    print("RAW_RESPONSE:", body)
except Exception as exc:
    print("ERROR_TYPE:", type(exc).__name__)
    print("ERROR:", exc)
    traceback.print_exc()
