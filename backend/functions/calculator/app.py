import json
import logging
import os
from datetime import datetime, timezone

import boto3

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

WEBSOCKET_CHUNK_SIZE_CHARS = int(os.environ.get("WEBSOCKET_CHUNK_SIZE_CHARS", "180"))

# Runtime configuration comes from Lambda environment variables.
RUNTIME_ID = os.environ.get("AGENTCORE_RUNTIME_ID", "")
RUNTIME_ARN = os.environ.get("AGENTCORE_RUNTIME_ARN", "")


def _apigw_management_client(event):
    # Build the WebSocket management client for the active connection.
    request_context = event.get("requestContext", {})
    domain_name = request_context.get("domainName")
    stage = request_context.get("stage")
    endpoint = f"https://{domain_name}/{stage}"
    return boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)


def _post_to_connection(event, payload):
    # Send one JSON response back to the caller.
    connection_id = event.get("requestContext", {}).get("connectionId")
    if not connection_id:
        return

    mgmt = _apigw_management_client(event)
    mgmt.post_to_connection(
        ConnectionId=connection_id,
        Data=json.dumps(payload).encode("utf-8"),
    )


def _post_status_update(event, request_id, session_id, status_text):
    _post_to_connection(
        event,
        {
            "type": "status_update",
            "mode": "assistant",
            "requestId": request_id,
            "sessionId": session_id,
            "status": status_text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


def _chunk_text(text, chunk_size):
    value = str(text or "")
    if not value:
        return [""]

    chunks = []
    start = 0
    size = max(40, int(chunk_size))
    while start < len(value):
        end = min(start + size, len(value))
        chunks.append(value[start:end])
        start = end

    # Force at least two chunks for short-but-meaningful responses so UI can render progressive updates.
    if len(chunks) == 1 and len(value) > 20:
        midpoint = max(1, len(value) // 2)
        chunks = [value[:midpoint], value[midpoint:]]
    return chunks


def _extract_answer_text(value):
    # Recursively extract plain text answer from nested objects/lists/JSON strings.
    if isinstance(value, dict):
        for key in ("explanation", "answer", "outputText", "text", "message"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                text = candidate.strip()

                # Strip markdown code fences if model wrapped JSON in ```json ... ```
                if text.startswith("```") and text.endswith("```"):
                    lines = text.splitlines()
                    if len(lines) >= 3:
                        text = "\n".join(lines[1:-1]).strip()

                if text.startswith("{") and text.endswith("}"):
                    try:
                        parsed = json.loads(text)
                        nested = _extract_answer_text(parsed)
                        if nested:
                            return nested
                    except Exception:
                        pass
                return text

        for nested_value in value.values():
            extracted = _extract_answer_text(nested_value)
            if extracted:
                return extracted
        return ""

    if isinstance(value, list):
        for item in value:
            extracted = _extract_answer_text(item)
            if extracted:
                return extracted
        return ""

    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""

        if text.startswith("```") and text.endswith("```"):
            lines = text.splitlines()
            if len(lines) >= 3:
                text = "\n".join(lines[1:-1]).strip()

        try:
            parsed = json.loads(text)
            nested = _extract_answer_text(parsed)
            if nested:
                return nested
        except Exception:
            pass
        return text

    return ""


def _status_for_prompt(prompt_text):
    text = str(prompt_text or "").strip().lower()
    if not text:
        return "Generating response"

    calc_keywords = (
        "calculate",
        "total",
        "sum",
        "price",
        "cost",
        "multiply",
        "add",
        "subtract",
        "divide",
        "xray",
        "mammography",
    )

    has_digit = any(ch.isdigit() for ch in text)
    has_math_op = any(op in text for op in ("+", "-", "*", "/", " x "))
    looks_like_calc = has_digit and (has_math_op or any(token in text for token in calc_keywords))

    if looks_like_calc:
        return "Calculating result"
    return "Generating response"


def _runtime_prompt_with_markdown(prompt_text):
    prompt = str(prompt_text or "").strip()
    if not prompt:
        return prompt

    return (
        f"{prompt}\n\n"
        "Formatting requirements:\n"
        "- Return GitHub-flavored markdown.\n"
        "- Do not return JSON wrappers unless explicitly requested.\n"
        "- For calculations, show the final result on its own line and then brief steps as bullets.\n"
        "- Do not use markdown tables."
    )


def _post_assistant_response(event, base_payload):
    answer = str(base_payload.get("answer", ""))
    chunks = _chunk_text(answer, WEBSOCKET_CHUNK_SIZE_CHARS)
    request_id = base_payload.get("requestId")

    for index, piece in enumerate(chunks, start=1):
        _post_to_connection(
            event,
            {
                "type": "assistant_response_chunk",
                "mode": base_payload.get("mode", "assistant"),
                "status": base_payload.get("status", "success"),
                "requestId": request_id,
                "sessionId": base_payload.get("sessionId"),
                "answerChunk": piece,
                "chunkIndex": index,
                "chunkTotal": len(chunks),
                "timestamp": base_payload.get("timestamp"),
            },
        )

    _post_to_connection(
        event,
        {
            "type": "assistant_response_end",
            "mode": base_payload.get("mode", "assistant"),
            "status": base_payload.get("status", "success"),
            "requestId": request_id,
            "sessionId": base_payload.get("sessionId"),
            "timestamp": base_payload.get("timestamp"),
        },
    )


def _parse_body(event):
    # Decode the WebSocket body into a Python dictionary.
    body = event.get("body") or "{}"
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


def _invoke_runtime(payload):
    # Use the Bedrock AgentCore client shape supported by this environment.
    prompt = _runtime_prompt_with_markdown(payload.get("prompt", ""))
    session_id = payload.get("sessionId")
    request_id = payload.get("requestId")
    id_token = payload.get("idToken")

    agent_payload = {
        "prompt": prompt,
        "session_id": session_id,
        "client_request_id": request_id,
    }
    if id_token:
        agent_payload["jwt_token"] = id_token

    def _decode_response(response):
        body = response.get("response") or response.get("body")
        if hasattr(body, "read"):
            body = body.read()
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8")
        if isinstance(body, str):
            try:
                return json.loads(body)
            except Exception:
                return {"answer": body}
        if isinstance(body, dict):
            return body
        return response

    runtime_payload = json.dumps(agent_payload)
    try:
        runtime_client = boto3.client("bedrock-agentcore")
    except Exception as exc:
        raise RuntimeError(f"Unable to create Bedrock AgentCore client: {exc}") from exc

    if not RUNTIME_ARN:
        raise RuntimeError("AGENTCORE_RUNTIME_ARN is required")

    call_attempts = [
        {
            "agentRuntimeArn": RUNTIME_ARN,
            "payload": runtime_payload,
        },
        {
            "agentRuntimeArn": RUNTIME_ARN,
            "payload": runtime_payload,
            "contentType": "application/json",
            "accept": "application/json",
        },
    ]

    last_error = None
    for params in call_attempts:
        try:
            response = runtime_client.invoke_agent_runtime(**params)
            decoded = _decode_response(response)
            answer_text = _extract_answer_text(decoded)
            if answer_text:
                return {"answer": answer_text, "raw": decoded}
            return decoded
        except Exception as exc:
            last_error = exc

    raise RuntimeError(f"Unable to invoke AgentCore runtime: {last_error}")


def lambda_handler(event, _context):
    # Handle connect/disconnect events and calculator prompts.
    route_key = event.get("requestContext", {}).get("routeKey")

    if route_key in {"$connect", "$disconnect"}:
        return {"statusCode": 200, "body": "ok"}

    payload = _parse_body(event)
    request_id = payload.get("requestId")

    if route_key == "$default" and payload.get("action") != "calculator":
        _post_to_connection(
            event,
            {
                "type": "error",
                "message": "Use action=calculator or action=observability_evaluation",
            },
        )
        return {"statusCode": 200, "body": "ignored"}

    if not payload.get("prompt"):
        _post_to_connection(
            event,
            {
                "type": "error",
                "requestId": request_id,
                "message": "Prompt is required",
            },
        )
        return {"statusCode": 200, "body": "validation_error"}

    try:
        _post_status_update(
            event,
            request_id,
            payload.get("sessionId"),
            _status_for_prompt(payload.get("prompt")),
        )

        runtime_response = _invoke_runtime(payload)
        answer = _extract_answer_text(runtime_response) or runtime_response.get("answer") or runtime_response.get("explanation") or json.dumps(runtime_response)

        if isinstance(answer, str):
            stripped = answer.strip()
            if stripped.startswith("```") and stripped.endswith("```"):
                lines = stripped.splitlines()
                if len(lines) >= 3:
                    stripped = "\n".join(lines[1:-1]).strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                try:
                    parsed_answer = json.loads(stripped)
                    if isinstance(parsed_answer, dict):
                        answer = _extract_answer_text(parsed_answer) or parsed_answer.get("explanation") or parsed_answer.get("answer") or answer
                except Exception:
                    pass

        _post_assistant_response(
            event,
            {
                "type": "assistant_response",
                "mode": "assistant",
                "status": runtime_response.get("status", "success"),
                "requestId": request_id,
                "sessionId": runtime_response.get("session_id") or payload.get("sessionId"),
                "answer": answer,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:
        LOGGER.exception("Calculator lambda failed")
        _post_to_connection(
            event,
            {
                "type": "error",
                "mode": "assistant",
                "requestId": request_id,
                "message": str(exc),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )

    return {"statusCode": 200, "body": "ok"}
