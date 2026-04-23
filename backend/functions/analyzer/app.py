import json
import logging
import os
import time
import traceback
import base64
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timedelta, timezone

import boto3
from botocore.config import Config

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

# Runtime inputs for the analyzer come from Lambda environment variables.
RUNTIME_LOG_GROUP = os.environ.get("RUNTIME_LOG_GROUP", "")
RUNTIME_LOG_STREAM = os.environ.get("RUNTIME_LOG_STREAM", "agent-traces")
EVALUATOR_LOG_GROUP = os.environ.get("EVALUATOR_LOG_GROUP", "")
ANALYZER_MODEL_ID = os.environ.get("ANALYZER_MODEL_ID", "")
DEFAULT_ANALYSIS_LOOKBACK_HOURS = int(os.environ.get("DEFAULT_ANALYSIS_LOOKBACK_HOURS", "720"))
ANALYZER_REQUEST_BUDGET_SECONDS = int(os.environ.get("ANALYZER_REQUEST_BUDGET_SECONDS", "22"))
ANALYZER_MAX_QUERY_RESULTS = int(os.environ.get("ANALYZER_MAX_QUERY_RESULTS", "5000"))
WEBSOCKET_MAX_RESPONSE_BYTES = int(os.environ.get("WEBSOCKET_MAX_RESPONSE_BYTES", "30000"))
WEBSOCKET_CHUNK_SIZE_CHARS = int(os.environ.get("WEBSOCKET_CHUNK_SIZE_CHARS", "180"))
ANALYZER_AUDIT_LOG_GROUP = os.environ.get("ANALYZER_AUDIT_LOG_GROUP", "/aws/sensei/analyzer-websocket")
ANALYZER_AUDIT_LOG_STREAM = os.environ.get("ANALYZER_AUDIT_LOG_STREAM", "analyser-websocket")

# Reuse one client set so the handler stays small and predictable.
logs_client = boto3.client("logs")
bedrock_client = boto3.client(
    "bedrock-runtime",
    config=Config(
        connect_timeout=5,
        read_timeout=20,
        retries={"max_attempts": 2},
    ),
)
xray_client = boto3.client("xray")

_audit_stream_ready = False


# Create the audit group and stream lazily so cold starts stay cheap.
def _ensure_audit_stream():
    global _audit_stream_ready
    if _audit_stream_ready:
        return True

    # Create the audit group and stream lazily so cold starts stay cheap.
    try:
        logs_client.create_log_group(logGroupName=ANALYZER_AUDIT_LOG_GROUP)
    except logs_client.exceptions.ResourceAlreadyExistsException:
        pass
    except Exception:
        LOGGER.debug("create_log_group skipped", exc_info=True)

    try:
        logs_client.create_log_stream(
            logGroupName=ANALYZER_AUDIT_LOG_GROUP,
            logStreamName=ANALYZER_AUDIT_LOG_STREAM,
        )
    except logs_client.exceptions.ResourceAlreadyExistsException:
        pass
    except Exception:
        LOGGER.warning("Failed to create analyzer audit log stream", exc_info=True)
        return False

    _audit_stream_ready = True
    return True


# Render any payload safely for logs without letting it explode in size.
def _safe_preview(value, max_chars=2000):
    # Render any payload safely for logs without letting it explode in size.
    try:
        rendered = json.dumps(value, ensure_ascii=True, default=str)
    except Exception:
        rendered = str(value)
    if len(rendered) > max_chars:
        return rendered[:max_chars] + "..."
    return rendered


# Write one compact audit record for every important analyzer step.
def _audit(stage, request_id, **fields):
    # Write one compact audit record for every important analyzer step.
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "request_id": request_id,
        "fields": fields,
    }
    LOGGER.info("analyzer_audit %s", _safe_preview(payload, max_chars=5000))

    if not _ensure_audit_stream():
        return

    event = {
        "timestamp": int(time.time() * 1000),
        "message": _safe_preview(payload, max_chars=20000),
    }

    try:
        logs_client.put_log_events(
            logGroupName=ANALYZER_AUDIT_LOG_GROUP,
            logStreamName=ANALYZER_AUDIT_LOG_STREAM,
            logEvents=[event],
        )
    except Exception:
        LOGGER.warning("Failed to write analyzer audit event", exc_info=True)


# Parse lookback values with simple hour/day handling.
def _parse_lookback_hours(raw_value, fallback):
    default = int(fallback)
    if raw_value is None:
        return default

    text = str(raw_value).strip().lower()
    if not text:
        return default

    try:
        if text.endswith("d"):
            return min(max(1, int(float(text[:-1]) * 24)), 24 * 90)
        if text.endswith("h"):
            return min(max(1, int(float(text[:-1]))), 24 * 90)
        return min(max(1, int(float(text))), 24 * 90)
    except Exception:
        return default


# Convert Unix nanoseconds into epoch milliseconds.
def _to_epoch_ms_from_unix_nano(value):
    try:
        return int(int(value) / 1_000_000)
    except Exception:
        return 0


# Extract evaluator metric rows from one telemetry event.
def _extract_evaluator_metric_records(event):
    attributes = event.get("attributes") or {}
    metric_name = attributes.get("gen_ai.evaluation.name")
    if not metric_name:
        return []

    score_value = attributes.get("gen_ai.evaluation.score.value")
    try:
        score_value = float(score_value)
    except Exception:
        score_value = 0.0

    severity_number = event.get("severityNumber")
    try:
        severity_number = int(severity_number)
    except Exception:
        severity_number = None

    session_id = attributes.get("session.id") or attributes.get("gen_ai.response.id") or "unknown-session"

    # Evaluator traces can be emitted under different keys depending on emitter/version.
    trace_candidates = {
        event.get("traceId"),  # Top-level traceId from structured logs
        attributes.get("aws.bedrock_agentcore.evaluation_start_trace_id"),
        attributes.get("aws.bedrock_agentcore.evaluation_end_trace_id"),
        attributes.get("trace_id"),
        attributes.get("xray_trace_id"),
        attributes.get("aws.xray.trace_id"),
        attributes.get("gen_ai.trace_id"),
        event.get("trace_id"),
        event.get("xray_trace_id"),
    }
    trace_ids = [trace_id for trace_id in trace_candidates if trace_id]
    if not trace_ids:
        return []

    label = attributes.get("gen_ai.evaluation.score.label") or event.get("label")
    explanation = attributes.get("gen_ai.evaluation.explanation", "")
    timestamp_ms = _to_epoch_ms_from_unix_nano(event.get("timeUnixNano"))

    records = []
    for trace_id in trace_ids:
        records.append(
            {
                "trace_id": trace_id,
                "session_id": session_id,
                "metric_name": metric_name,
                "score": score_value,
                "label": label,
                "severity_number": severity_number,
                "explanation": explanation,
                "timestamp_epoch_ms": timestamp_ms,
            }
        )
    return records


# Walk X-Ray documents recursively so nested calls are preserved.
def _extract_xray_subsegments(segment_doc, parent_name=None):
    # Walk X-Ray documents recursively so nested calls are preserved.
    items = []
    name = segment_doc.get("name", "")
    namespace = segment_doc.get("namespace", "")
    start_time = segment_doc.get("start_time")
    end_time = segment_doc.get("end_time")

    duration_ms = 0.0
    try:
        if start_time is not None and end_time is not None:
            duration_ms = max(0.0, (float(end_time) - float(start_time)) * 1000)
    except Exception:
        duration_ms = 0.0

    http_status = None
    if isinstance(segment_doc.get("http"), dict):
        response_info = segment_doc.get("http", {}).get("response") or {}
        http_status = response_info.get("status")

    item = {
        "name": name,
        "namespace": namespace,
        "parent": parent_name,
        "duration_ms": round(duration_ms, 2),
        "has_error": bool(segment_doc.get("error", False)),
        "has_fault": bool(segment_doc.get("fault", False)),
        "has_throttle": bool(segment_doc.get("throttle", False)),
        "http_status": http_status,
    }

    if name or namespace:
        items.append(item)

    for child in segment_doc.get("subsegments", []) or []:
        if isinstance(child, dict):
            items.extend(_extract_xray_subsegments(child, parent_name=name or parent_name))

    return items


# Accept either X-Ray trace format and convert compact IDs when needed.
def _normalize_trace_id_for_xray(trace_id):
    # Accept either X-Ray trace format and convert compact IDs when needed.
    value = str(trace_id or "").strip()
    if not value:
        return ""

    if value.startswith("1-") and value.count("-") >= 2:
        return value

    compact = value.replace("-", "")
    if len(compact) == 32 and all(ch in "0123456789abcdefABCDEF" for ch in compact):
        return f"1-{compact[:8]}-{compact[8:]}"

    return ""


# Pull any trace IDs the user typed directly into the question.
def _extract_trace_ids_from_text(text):
    # Pull any trace IDs the user typed directly into the question.
    value = str(text or "")
    if not value:
        return []

    import re

    pattern = re.compile(r"\b(?:1-[0-9a-fA-F]{8}-[0-9a-fA-F]{24}|[0-9a-fA-F]{32})\b")
    seen = set()
    trace_ids = []
    for match in pattern.findall(value):
        normalized = _normalize_trace_id_for_xray(match)
        if normalized and normalized not in seen:
            seen.add(normalized)
            trace_ids.append(normalized)
    return trace_ids


# Convert an X-Ray trace ID into the alternate compact form when needed.
def _xray_alt_trace_id(trace_id):
    value = str(trace_id or "")
    if value.startswith("1-") and value.count("-") >= 2:
        parts = value.split("-", 2)
        if len(parts) == 3:
            return f"{parts[1]}{parts[2]}"
    return value


# Build the WebSocket management client for the active connection.
def _apigw_management_client(event):
    request_context = event.get("requestContext", {})
    endpoint = f"https://{request_context.get('domainName')}/{request_context.get('stage')}"
    return boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)


# Measure payload size in bytes so websocket limits can be enforced.
def _payload_size_bytes(payload):
    try:
        return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return 10**9


# Trim large analyzer payloads before sending them over the socket.
def _fit_payload_for_websocket(payload):
    candidate = dict(payload)
    if _payload_size_bytes(candidate) <= WEBSOCKET_MAX_RESPONSE_BYTES:
        return candidate

    data = candidate.get("data")
    if isinstance(data, dict):
        compact = dict(data)
        sessions = compact.get("sessions")
        if isinstance(sessions, dict):
            preview = []
            for session_id, session_data in list(sessions.items())[:5]:
                preview.append(
                    {
                        "session_id": session_id,
                        "trace_count": session_data.get("trace_count", 0),
                        "latest_trace_timestamp_utc": session_data.get("latest_trace_timestamp_utc", ""),
                    }
                )
            compact["sessions_preview"] = preview
            compact.pop("sessions", None)
        candidate["data"] = compact

    if _payload_size_bytes(candidate) <= WEBSOCKET_MAX_RESPONSE_BYTES:
        return candidate

    candidate.pop("data", None)
    if _payload_size_bytes(candidate) <= WEBSOCKET_MAX_RESPONSE_BYTES:
        return candidate

    answer_text = str(candidate.get("answer", ""))
    if len(answer_text) > 7000:
        candidate["answer"] = answer_text[:7000] + "\n\n[Response truncated due to websocket payload size limit.]"

    if _payload_size_bytes(candidate) > WEBSOCKET_MAX_RESPONSE_BYTES:
        candidate = {
            "type": candidate.get("type", "assistant_response"),
            "mode": candidate.get("mode", "analyzer"),
            "status": candidate.get("status", "success"),
            "requestId": candidate.get("requestId"),
            "sessionId": candidate.get("sessionId"),
            "answer": "Analyzer completed, but detailed payload exceeded websocket size limits.",
            "timestamp": candidate.get("timestamp"),
        }

    return candidate


# Send one JSON response back to the caller.
def _post_to_connection(event, payload):
    connection_id = event.get("requestContext", {}).get("connectionId")
    if not connection_id:
        return False
    final_payload = _fit_payload_for_websocket(payload)
    try:
        _apigw_management_client(event).post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(final_payload).encode("utf-8"),
        )
        return True
    except Exception:
        LOGGER.exception("PostToConnection failed")
        return False


# Split long answers into websocket-friendly chunks.
def _chunk_text(text, chunk_size):
    # Split long answers into websocket-friendly chunks.
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


# Send one assistant chunk frame over websocket.
def _post_status_update(event, base_payload, status_text):
    """Send a real status event (collecting logs, analyzing, generating answer, etc)."""
    _post_to_connection(
        event,
        {
            "type": "status_update",
            "mode": base_payload.get("mode"),
            "status": status_text,
            "requestId": base_payload.get("requestId"),
            "sessionId": base_payload.get("sessionId"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


def _post_assistant_response_chunk(event, base_payload, piece, chunk_index, chunk_total=0):
    _post_to_connection(
        event,
        {
            "type": "assistant_response_chunk",
            "mode": base_payload.get("mode"),
            "status": base_payload.get("status", "success"),
            "requestId": base_payload.get("requestId"),
            "sessionId": base_payload.get("sessionId"),
            "answerChunk": piece,
            "chunkIndex": chunk_index,
            "chunkTotal": chunk_total,
            "timeframeLabel": base_payload.get("timeframeLabel"),
            "pagination": base_payload.get("pagination"),
            "timestamp": base_payload.get("timestamp"),
        },
    )


# Send assistant stream end frame over websocket.
def _post_assistant_response_end(event, base_payload):
    _post_to_connection(
        event,
        {
            "type": "assistant_response_end",
            "mode": base_payload.get("mode"),
            "status": base_payload.get("status", "success"),
            "requestId": base_payload.get("requestId"),
            "sessionId": base_payload.get("sessionId"),
            "timeframeLabel": base_payload.get("timeframeLabel"),
            "continuationToken": base_payload.get("continuationToken"),
            "pagination": base_payload.get("pagination"),
            "timestamp": base_payload.get("timestamp"),
        },
    )


# Send chunked analyzer responses and the final end marker.
def _post_assistant_response(event, base_payload):
    answer = str(base_payload.get("answer", ""))
    chunks = _chunk_text(answer, WEBSOCKET_CHUNK_SIZE_CHARS)

    request_id = base_payload.get("requestId")
    for index, piece in enumerate(chunks, start=1):
        _post_assistant_response_chunk(event, base_payload, piece, index, len(chunks))

    _post_assistant_response_end(event, base_payload)


# Decode the WebSocket body into a Python dictionary.
def _parse_body(event):
    body = event.get("body") or "{}"
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


# Track how much time is left in the analyzer request budget.
def _seconds_left(start_time_epoch):
    elapsed = time.time() - start_time_epoch
    return max(0.0, ANALYZER_REQUEST_BUDGET_SECONDS - elapsed)


# Extract the first JSON object from model output.
def _extract_json_object(text):
    if not text:
        return {}

    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")

    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}

    candidate = raw[start : end + 1]
    try:
        return json.loads(candidate)
    except Exception:
        return {}


# Call Bedrock Converse and return the plain text response.
def _converse_text(prompt, max_tokens, temperature):
    last_error = None
    for attempt in range(3):
        try:
            response = bedrock_client.converse(
                modelId=ANALYZER_MODEL_ID,
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": prompt}],
                    }
                ],
                inferenceConfig={
                    "maxTokens": max_tokens,
                    "temperature": temperature,
                },
            )

            output = response.get("output", {}).get("message", {}).get("content", [])
            text_parts = [part.get("text", "") for part in output if "text" in part]
            return "\n".join(text_parts).strip()
        except Exception as exc:
            last_error = exc
            message = str(exc).lower()
            if "serviceunavailableexception" not in message and "too many connections" not in message:
                raise
            if attempt == 2:
                raise
            time.sleep(0.6 * (attempt + 1))

    raise last_error


# Extract one text delta from a Bedrock ConverseStream event payload.
def _extract_stream_text(event):
    if not isinstance(event, dict):
        return ""

    block_delta = event.get("contentBlockDelta")
    if isinstance(block_delta, dict):
        delta = block_delta.get("delta")
        if isinstance(delta, dict):
            text = delta.get("text")
            if isinstance(text, str):
                return text

    delta = event.get("delta")
    if isinstance(delta, dict):
        text = delta.get("text")
        if isinstance(text, str):
            return text

    output_text = event.get("outputText")
    if isinstance(output_text, str):
        return output_text
    return ""


# Call Bedrock ConverseStream and emit text chunks as they are generated.
def _converse_text_stream(prompt, max_tokens, temperature, start_time_epoch=None, on_text_chunk=None):
    last_error = None
    for attempt in range(3):
        collected_parts = []
        buffered_text = ""
        emitted_any = False

        try:
            response = bedrock_client.converse_stream(
                modelId=ANALYZER_MODEL_ID,
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": prompt}],
                    }
                ],
                inferenceConfig={
                    "maxTokens": max_tokens,
                    "temperature": temperature,
                },
            )

            flush_size = max(40, min(int(WEBSOCKET_CHUNK_SIZE_CHARS), 240))
            for event in response.get("stream", []):
                if start_time_epoch is not None and _seconds_left(start_time_epoch) < 2.2:
                    if buffered_text and on_text_chunk:
                        on_text_chunk(buffered_text)
                        emitted_any = True
                        buffered_text = ""
                    partial = "".join(collected_parts).strip()
                    if partial:
                        return partial + "\n\n[Partial response due to analyzer timeout.]"
                    raise TimeoutError("Model response timed out. Please retry or reduce timeframe.")

                piece = _extract_stream_text(event)
                if not piece:
                    continue

                collected_parts.append(piece)
                if on_text_chunk:
                    buffered_text += piece
                    while len(buffered_text) >= flush_size:
                        on_text_chunk(buffered_text[:flush_size])
                        emitted_any = True
                        buffered_text = buffered_text[flush_size:]

            if buffered_text and on_text_chunk:
                on_text_chunk(buffered_text)
                emitted_any = True

            full_text = "".join(collected_parts).strip()
            if full_text:
                return full_text
            if emitted_any:
                return ""
            return _converse_text(prompt, max_tokens, temperature)

        except Exception as exc:
            last_error = exc
            message = str(exc).lower()

            if "read timeout" in message or "timed out" in message:
                partial = "".join(collected_parts).strip()
                if partial:
                    if buffered_text and on_text_chunk:
                        on_text_chunk(buffered_text)
                    return partial + "\n\n[Partial response due to model timeout.]"
                raise TimeoutError("Model response timed out. Please retry or reduce timeframe.") from exc

            if "serviceunavailableexception" in message or "too many connections" in message:
                if attempt == 2:
                    raise
                time.sleep(0.6 * (attempt + 1))
                continue
            raise

    raise last_error


# Run the model call with a timeout guard for websocket safety.
def _converse_text_with_timeout(start_time_epoch, prompt, max_tokens, temperature):
    # Keep explicit headroom to post response/error over websocket before lambda timeout.
    if _seconds_left(start_time_epoch) < 4:
        raise TimeoutError("Analyzer timed out before model generation could start.")

    timeout_seconds = max(4.0, min(20.0, _seconds_left(start_time_epoch) - 2.5))
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_converse_text, prompt, max_tokens, temperature)
    try:
        return future.result(timeout=timeout_seconds)
    except FutureTimeoutError as exc:
        future.cancel()
        raise TimeoutError("Model response timed out. Please retry or reduce timeframe.") from exc
    except Exception as exc:
        message = str(exc).lower()
        if "read timeout" in message or "timed out" in message:
            raise TimeoutError("Model response timed out. Please retry or reduce timeframe.") from exc
        raise
    finally:
        # Avoid waiting for background worker completion on timeout.
        executor.shutdown(wait=False, cancel_futures=True)


# Try model generation with one bounded retry before falling back.
def _generate_answer_with_retry(start_time_epoch, question, prompt_context, conversation, max_tokens, temperature):
    base_prompt = _answer_prompt(question, prompt_context, conversation=conversation)
    try:
        return _converse_text_with_timeout(start_time_epoch, base_prompt, max_tokens=max_tokens, temperature=temperature)
    except TimeoutError:
        # Only retry when enough request budget remains.
        if _seconds_left(start_time_epoch) < 5:
            raise

        compact_context = dict(prompt_context)
        if isinstance(compact_context.get("session_rows"), list) and len(compact_context["session_rows"]) > 20:
            compact_context["session_rows"] = compact_context["session_rows"][:20]
            compact_context["session_rows_truncated"] = True
        if isinstance(compact_context.get("trace_rows"), list) and len(compact_context["trace_rows"]) > 30:
            compact_context["trace_rows"] = compact_context["trace_rows"][:30]
            compact_context["trace_rows_truncated"] = True
        if isinstance(compact_context.get("sessions"), dict) and len(compact_context["sessions"]) > 6:
            compact_context["sessions"] = dict(list(compact_context["sessions"].items())[:6])
            compact_context["sessions_truncated"] = True

        retry_question = (
            f"{question}\n"
            "Produce a concise response in under 150 words. Prioritize exact counts and full IDs from context."
        )
        retry_prompt = _answer_prompt(retry_question, compact_context, conversation=conversation)
        retry_tokens = max(260, min(420, int(max_tokens * 0.7)))
        return _converse_text_with_timeout(start_time_epoch, retry_prompt, max_tokens=retry_tokens, temperature=0.0)
    except Exception as exc:
        message = str(exc).lower()
        if "serviceunavailableexception" not in message and "too many connections" not in message:
            raise

        if _seconds_left(start_time_epoch) < 5:
            raise TimeoutError("Analyzer model is temporarily busy and there is not enough time left to retry.") from exc

        compact_context = dict(prompt_context)
        if isinstance(compact_context.get("session_rows"), list) and len(compact_context["session_rows"]) > 20:
            compact_context["session_rows"] = compact_context["session_rows"][:20]
            compact_context["session_rows_truncated"] = True
        if isinstance(compact_context.get("trace_rows"), list) and len(compact_context["trace_rows"]) > 30:
            compact_context["trace_rows"] = compact_context["trace_rows"][:30]
            compact_context["trace_rows_truncated"] = True
        if isinstance(compact_context.get("sessions"), dict) and len(compact_context["sessions"]) > 6:
            compact_context["sessions"] = dict(list(compact_context["sessions"].items())[:6])
            compact_context["sessions_truncated"] = True

        retry_question = (
            f"{question}\n"
            "Produce a concise response in under 150 words. Prioritize exact counts and full IDs from context."
        )
        retry_prompt = _answer_prompt(retry_question, compact_context, conversation=conversation)
        retry_tokens = max(260, min(420, int(max_tokens * 0.7)))
        return _converse_text_with_timeout(start_time_epoch, retry_prompt, max_tokens=retry_tokens, temperature=0.0)


# Stream answer generation with one bounded retry before fallback.
def _generate_answer_with_retry_streaming(
    start_time_epoch,
    question,
    prompt_context,
    conversation,
    max_tokens,
    temperature,
    on_text_chunk,
):
    base_prompt = _answer_prompt(question, prompt_context, conversation=conversation)
    try:
        return _converse_text_stream(
            base_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            start_time_epoch=start_time_epoch,
            on_text_chunk=on_text_chunk,
        )
    except TimeoutError:
        if _seconds_left(start_time_epoch) < 5:
            raise

        compact_context = dict(prompt_context)
        if isinstance(compact_context.get("session_rows"), list) and len(compact_context["session_rows"]) > 20:
            compact_context["session_rows"] = compact_context["session_rows"][:20]
            compact_context["session_rows_truncated"] = True
        if isinstance(compact_context.get("trace_rows"), list) and len(compact_context["trace_rows"]) > 30:
            compact_context["trace_rows"] = compact_context["trace_rows"][:30]
            compact_context["trace_rows_truncated"] = True
        if isinstance(compact_context.get("sessions"), dict) and len(compact_context["sessions"]) > 6:
            compact_context["sessions"] = dict(list(compact_context["sessions"].items())[:6])
            compact_context["sessions_truncated"] = True

        retry_question = (
            f"{question}\n"
            "Produce a concise response in under 150 words. Prioritize exact counts and full IDs from context."
        )
        retry_prompt = _answer_prompt(retry_question, compact_context, conversation=conversation)
        retry_tokens = max(260, min(420, int(max_tokens * 0.7)))
        return _converse_text_stream(
            retry_prompt,
            max_tokens=retry_tokens,
            temperature=0.0,
            start_time_epoch=start_time_epoch,
            on_text_chunk=on_text_chunk,
        )
    except Exception as exc:
        message = str(exc).lower()
        if "serviceunavailableexception" not in message and "too many connections" not in message:
            raise

        if _seconds_left(start_time_epoch) < 5:
            raise TimeoutError("Analyzer model is temporarily busy and there is not enough time left to retry.") from exc

        compact_context = dict(prompt_context)
        if isinstance(compact_context.get("session_rows"), list) and len(compact_context["session_rows"]) > 20:
            compact_context["session_rows"] = compact_context["session_rows"][:20]
            compact_context["session_rows_truncated"] = True
        if isinstance(compact_context.get("trace_rows"), list) and len(compact_context["trace_rows"]) > 30:
            compact_context["trace_rows"] = compact_context["trace_rows"][:30]
            compact_context["trace_rows_truncated"] = True
        if isinstance(compact_context.get("sessions"), dict) and len(compact_context["sessions"]) > 6:
            compact_context["sessions"] = dict(list(compact_context["sessions"].items())[:6])
            compact_context["sessions_truncated"] = True

        retry_question = (
            f"{question}\n"
            "Produce a concise response in under 150 words. Prioritize exact counts and full IDs from context."
        )
        retry_prompt = _answer_prompt(retry_question, compact_context, conversation=conversation)
        retry_tokens = max(260, min(420, int(max_tokens * 0.7)))
        return _converse_text_stream(
            retry_prompt,
            max_tokens=retry_tokens,
            temperature=0.0,
            start_time_epoch=start_time_epoch,
            on_text_chunk=on_text_chunk,
        )


# Normalize the planner output into a bounded request plan.
def _normalize_plan(question, plan, requested_lookback_hours):
    data = plan if isinstance(plan, dict) else {}

    lookback = data.get("lookback_hours")
    try:
        lookback = int(lookback)
    except Exception:
        lookback = int(requested_lookback_hours)
    lookback = min(max(1, lookback), 24 * 90)

    def _as_list(value):
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if value is None:
            return []
        text = str(value).strip()
        return [text] if text else []

    detail = str(data.get("detail_level", "medium")).lower()
    if detail not in {"low", "medium", "high"}:
        detail = "medium"

    intent_type = str(data.get("intent_type", "other")).lower()
    data_scope = str(data.get("data_scope", "fleet_window")).lower()
    session_ids = _as_list(data.get("session_ids"))
    trace_ids = _as_list(data.get("trace_ids"))
    user_ids = _as_list(data.get("user_ids"))
    user_names = _as_list(data.get("user_names"))
    metrics_focus = [item.lower() for item in _as_list(data.get("metrics_focus"))]

    # Normalize planner metric aliases so downstream routing is stable.
    alias_map = {
        "trace_details": "trace_ids",
        "trace_detail": "trace_ids",
        "trace": "trace_ids",
        "session_detail": "session_ids",
    }
    metrics_focus = [alias_map.get(item, item) for item in metrics_focus]

    # Trace-targeted requests should use deep-dive path (not listing pagination path).
    if trace_ids and data_scope == "trace_window":
        if intent_type == "listing":
            intent_type = "deep_dive"
        if "trace_ids" not in metrics_focus:
            metrics_focus.append("trace_ids")

    # Keep listing behavior stable even when planner omits metrics_focus.
    if intent_type == "listing" and not metrics_focus:
        metrics_focus = ["session_ids"]

    return {
        "intent_type": intent_type,
        "data_scope": data_scope,
        "lookback_hours": lookback,
        "detail_level": detail,
        "session_ids": session_ids,
        "trace_ids": trace_ids,
        "user_ids": user_ids,
        "user_names": user_names,
        "metrics_focus": metrics_focus,
        "question": question,
    }


# Keep only the latest turns so the prompt stays bounded.
def _normalize_conversation(conversation):
    # Keep only the latest turns so the prompt stays bounded.
    if not isinstance(conversation, list):
        return []

    normalized = []
    for item in conversation[-12:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        text = str(item.get("text", "")).strip()
        if role not in {"user", "assistant"} or not text:
            continue
        normalized.append({"role": role, "text": text[:1200]})
    return normalized


# Render the prior conversation as a plain text block.
def _conversation_block(conversation):
    if not conversation:
        return "(no prior conversation)"
    lines = []
    for turn in conversation:
        lines.append(f"{turn['role']}: {turn['text']}")
    return "\n".join(lines)


# Use Bedrock to turn the user question into a structured plan.
def _infer_analysis_plan(question, requested_lookback_hours, start_time_epoch, conversation=None):
    # Use Bedrock to turn the user question into a structured plan.
    if _seconds_left(start_time_epoch) < 7:
        return _normalize_plan(question, {}, requested_lookback_hours)

    planner_prompt = (
        "You are a planning model for a log analyzer system. "
        "Infer user intent and data scope from the user's meaning, not from exact keywords. "
        "The user may write vague, conversational, misspelled, or non-technical requests. "
        "Your job is to choose the most useful analysis action from the wording, the conversation context, and the data scope implied by the request. "
        "Return ONLY valid JSON and no markdown.\n\n"
        "JSON schema:\n"
        "{\n"
        "  \"intent_type\": \"summary|listing|comparison|deep_dive|anomaly|general_conversation|other\",\n"
        "  \"data_scope\": \"fleet_window|user_window|session_window|trace_window|none\",\n"
        "  \"lookback_hours\": number,\n"
        "  \"detail_level\": \"low|medium|high\",\n"
        "  \"session_ids\": [string],\n"
        "  \"trace_ids\": [string],\n"
        "  \"user_ids\": [string],\n"
        "  \"user_names\": [string],\n"
        "  \"metrics_focus\": [string]\n"
        "}\n\n"
        f"Default lookback_hours if not specified by user: {requested_lookback_hours}.\n"
        "If the question is broad (summary, list all users, fleet trends), keep data_scope as fleet_window and keep entity arrays empty.\n"
        "If the user is only greeting, making small talk, or asking a broad non-data conversation question, choose intent_type general_conversation and do not invent data entities.\n"
        "For general_conversation, keep data_scope as none when possible.\n"
        "Do not invent IDs. Keep arrays empty when unknown.\n"
        "If the user asks for sessions, session history, session details, activity, recent work, or 'more info' about a named user's sessions, treat that as a listing request unless the user explicitly asks for a narrative summary only.\n"
        "If the user asks for traces, trace details, or request-level history, treat that as a listing request for trace IDs.\n"
        "If the user asks for a short report, summary, overview, or quick readout, treat that as a summary request.\n"
        "For very short follow-up turns (for example, requests to continue), infer intent from recent conversation context and continue the same analysis direction instead of switching scope.\n"
        "For follow-up turns, preserve previously identified user/session/trace targets unless the user explicitly changes them.\n"
        "Prefer the most useful interpretation for a non-technical user when the wording is vague. If one interpretation is clearly better, choose it rather than returning 'other'.\n"
        "Only use 'other' when the request is genuinely unrelated to the available data or cannot be mapped to a useful analyzer action.\n"
        "Examples:\n"
        "Q: list out all session ids\n"
        "A: {\"intent_type\":\"listing\",\"data_scope\":\"fleet_window\",\"lookback_hours\":720,\"detail_level\":\"medium\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[],\"metrics_focus\":[\"session_ids\"]}\n"
        "Q: list out all the sessions\n"
        "A: {\"intent_type\":\"listing\",\"data_scope\":\"fleet_window\",\"lookback_hours\":720,\"detail_level\":\"medium\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[],\"metrics_focus\":[\"session_ids\"]}\n"
        "Q: give me more info about the sessions for nikhil\n"
        "A: {\"intent_type\":\"listing\",\"data_scope\":\"user_window\",\"lookback_hours\":720,\"detail_level\":\"medium\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[\"nikhil\"],\"metrics_focus\":[\"session_ids\"]}\n"
        "Q: give me a short report for the user nikhil\n"
        "A: {\"intent_type\":\"summary\",\"data_scope\":\"user_window\",\"lookback_hours\":720,\"detail_level\":\"low\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[\"nikhil\"],\"metrics_focus\":[]}\n"
        "Q: hi\n"
        "A: {\"intent_type\":\"general_conversation\",\"data_scope\":\"none\",\"lookback_hours\":720,\"detail_level\":\"low\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[],\"metrics_focus\":[]}\n"
        "Q: list all trace ids\n"
        "A: {\"intent_type\":\"listing\",\"data_scope\":\"fleet_window\",\"lookback_hours\":720,\"detail_level\":\"medium\",\"session_ids\":[],\"trace_ids\":[],\"user_ids\":[],\"user_names\":[],\"metrics_focus\":[\"trace_ids\"]}\n"
        f"Conversation context:\n{_conversation_block(conversation)}\n\n"
        f"User question:\n{question}"
    )

    try:
        planner_text = _converse_text(planner_prompt, max_tokens=320, temperature=0.0)
        planner_json = _extract_json_object(planner_text)
        normalized = _normalize_plan(question, planner_json, requested_lookback_hours)

        # Retry with a stricter pass when planner returns an ambiguous "other" plan.
        if normalized.get("intent_type") == "other" and _seconds_left(start_time_epoch) > 8:
            retry_prompt = (
                "Reclassify the same user question for analyzer planning. "
                "Return ONLY valid JSON using the exact schema below and no markdown.\n\n"
                "Schema keys: intent_type,data_scope,lookback_hours,detail_level,session_ids,trace_ids,user_ids,user_names,metrics_focus\n"
                "If question asks to list sessions, use intent_type=listing and metrics_focus=['session_ids'].\n"
                "If question asks to list traces, use intent_type=listing and metrics_focus=['trace_ids'].\n"
                f"Question:\n{question}\n\n"
                f"Prior ambiguous plan:\n{json.dumps(normalized, ensure_ascii=True)}"
            )
            retry_text = _converse_text(retry_prompt, max_tokens=220, temperature=0.0)
            retry_json = _extract_json_object(retry_text)
            normalized = _normalize_plan(question, retry_json, requested_lookback_hours)

        return normalized
    except Exception:
        LOGGER.exception("Planner model call failed")
        return _normalize_plan(question, {}, requested_lookback_hours)


# Execute a CloudWatch Logs Insights query with a hard timeout.
def _run_query(log_group, query, start_ms, end_ms, timeout_seconds, limit):
    # Execute a CloudWatch Logs Insights query with a hard timeout.
    if not log_group or timeout_seconds <= 0:
        return []

    result = logs_client.start_query(
        logGroupName=log_group,
        startTime=int(start_ms / 1000),
        endTime=int(end_ms / 1000),
        queryString=query,
        limit=max(1, min(int(limit), 10000)),
    )
    query_id = result["queryId"]

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        response = logs_client.get_query_results(queryId=query_id)
        if response.get("status") in {"Complete", "Failed", "Cancelled", "Timeout"}:
            return response.get("results", [])
        time.sleep(0.8)

    return []


# Parse one JSON log line from CloudWatch message text.
def _parse_json_message(raw_message):
    if not raw_message:
        return {}

    text = raw_message.strip()
    if "{" in text and not text.startswith("{"):
        text = text[text.find("{") :]

    try:
        return json.loads(text)
    except Exception:
        return {}


# Convert a Logs Insights row into a simple field dictionary.
def _from_insights_row(row):
    data = {}
    for field in row:
        data[field.get("field")] = field.get("value")
    return data


# Read runtime logs from the expected AgentCore trace stream only.
def _fetch_runtime_events(start_ms, end_ms, timeout_seconds, limit):
    # Read runtime logs from the expected AgentCore trace stream only.
    query = (
        "fields @timestamp, @logStream, @message "
        "| filter @logStream = 'agent-traces' "
        "| filter @message like /agent_request_trace/ "
        "| sort @timestamp desc"
    )
    rows = _run_query(RUNTIME_LOG_GROUP, query, start_ms, end_ms, timeout_seconds, limit)

    events = []
    for row in rows:
        parsed = _parse_json_message(_from_insights_row(row).get("@message", ""))
        if parsed:
            events.append(parsed)
    return events


# Read evaluator logs from the configured CloudWatch log group.
def _fetch_evaluator_events(start_ms, end_ms, timeout_seconds, limit):
    query = "fields @timestamp, @message | sort @timestamp desc"
    rows = _run_query(EVALUATOR_LOG_GROUP, query, start_ms, end_ms, timeout_seconds, limit)

    events = []
    for row in rows:
        parsed = _parse_json_message(_from_insights_row(row).get("@message", ""))
        if parsed:
            events.append(parsed)
    return events


# Fetch X-Ray details for the trace IDs we care about most.
def _fetch_xray_summaries(trace_ids, max_traces=30, max_subsegments=40):
    # Fetch X-Ray details for the trace IDs we care about most.
    normalized = []
    seen = set()
    for trace_id in trace_ids:
        item = _normalize_trace_id_for_xray(trace_id)
        if item and item not in seen:
            seen.add(item)
            normalized.append(item)

    clean_ids = normalized[:max_traces]
    if not clean_ids:
        return {}

    LOGGER.info(f"X-Ray fetch: input_trace_ids={trace_ids}, normalized={clean_ids}")

    batches = [clean_ids[i : i + 5] for i in range(0, len(clean_ids), 5)]
    results = {}
    fetch_errors = []
    total_traces_fetched = 0

    for batch in batches:
        try:
            response = xray_client.batch_get_traces(TraceIds=batch)
            traces_in_response = len(response.get("Traces", []))
            total_traces_fetched += traces_in_response
            LOGGER.info(f"X-Ray batch_get_traces batch={batch} returned {traces_in_response} traces")
        except Exception as e:
            error_msg = str(e)
            fetch_errors.append({"batch": batch, "error": error_msg})
            LOGGER.error(f"X-Ray batch_get_traces failed: batch={batch}, error={error_msg}")
            continue

        for trace in response.get("Traces", []):
            trace_id = trace.get("Id", "")
            subsegments = []
            for segment in trace.get("Segments", []) or []:
                document = segment.get("Document")
                if not document:
                    continue
                try:
                    segment_doc = json.loads(document)
                except Exception:
                    continue
                subsegments.extend(_extract_xray_subsegments(segment_doc))

            subsegments = sorted(subsegments, key=lambda item: item.get("duration_ms", 0), reverse=True)[:max_subsegments]
            payload = {
                "trace_id": trace_id,
                "duration_ms": float(trace.get("Duration", 0) * 1000),
                "has_error": trace.get("HasError", False),
                "has_fault": trace.get("HasFault", False),
                "has_throttle": trace.get("HasThrottle", False),
                "subsegments": subsegments,
            }
            results[trace_id] = payload
            results[_xray_alt_trace_id(trace_id)] = payload

    # Log fetch summary
    if fetch_errors:
        LOGGER.warning(f"X-Ray fetch errors: {fetch_errors}")
    LOGGER.info(f"X-Ray fetch complete: total_traces_fetched={total_traces_fetched}, results_keys={len(results)}")

    return results


# Join runtime, evaluator, and X-Ray data into a single session view.
def _merge_events(runtime_events, evaluator_events, xray_map):
    # Join runtime, evaluator, and X-Ray data into a single session view.
    traces = {}
    evaluator_by_trace = defaultdict(dict)

    for event in evaluator_events:
        for record in _extract_evaluator_metric_records(event):
            evaluator_by_trace[record["trace_id"]][record["metric_name"]] = {
                "score": record["score"],
                "label": record["label"],
                "severity_number": record["severity_number"],
                "trace_id": record["trace_id"],
                "session_id": record["session_id"],
            }

    for event in runtime_events:
        if event.get("event") and event.get("event") != "agent_request_trace":
            continue

        request_payload = event.get("request_payload") or {}
        response_payload = event.get("response_payload") or {}
        metrics_payload = event.get("metrics") or {}

        trace_id = event.get("xray_trace_id") or event.get("request_id")
        if not trace_id:
            continue

        session_id = str(event.get("session_id") or "").strip()
        if not session_id:
            continue
        timestamp = event.get("timestamp")
        ts_epoch = 0
        if timestamp:
            try:
                ts_epoch = int(datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                ts_epoch = 0

        traces[trace_id] = {
            "trace_id": trace_id,
            "status": event.get("status", "unknown"),
            "is_delayed": False,
            "timestamp_epoch_ms": ts_epoch,
            "timestamp_utc": timestamp,
            "session_id": session_id,
            "stage_latency_ms": {
                "runtime": float(
                    event.get("latency_ms")
                    or metrics_payload.get("latency_ms")
                    or 0
                ),
                "model_or_handoff_gap": 0.0,
                "evaluator": 0.0,
                "e2e": float(
                    event.get("latency_ms")
                    or metrics_payload.get("latency_ms")
                    or 0
                ),
            },
            "user": {
                "user_id": event.get("user_id", "unknown"),
                "user_name": event.get("user_name", "unknown"),
                "department": event.get("department", "unknown"),
                "user_role": event.get("user_role", "unknown"),
            },
            "evaluator_scores": {},
            "xray": xray_map.get(
                trace_id,
                {
                    "trace_id": trace_id,
                    "duration_ms": 0.0,
                    "has_error": False,
                    "has_fault": False,
                    "has_throttle": False,
                    "subsegments": [],
                },
            ),
            "token_usage": {
                "input": float(event.get("input_tokens") or metrics_payload.get("input_tokens") or 0),
                "output": float(event.get("output_tokens") or metrics_payload.get("output_tokens") or 0),
                "total": float(event.get("total_tokens") or metrics_payload.get("total_tokens") or 0),
            },
            "model_invocation": {
                "model_id": event.get("model_id", ""),
                "prompt_excerpt": str(event.get("prompt") or request_payload.get("prompt") or "")[:280],
                "answer_excerpt": str(event.get("answer") or response_payload.get("answer") or "")[:480],
            },
            "tool_trace": {
                "tools_used": metrics_payload.get("tools_used") or [],
                "tool_call_count": int(event.get("tools_count", 0) or 0),
            },
        }

    trace_aliases = {}
    for trace_id in traces.keys():
        trace_aliases[trace_id] = trace_id
        alias = _xray_alt_trace_id(trace_id)
        if alias:
            trace_aliases[alias] = trace_id

    # Build reverse xray lookup to handle ID format mismatches
    xray_aliases = {}
    for xray_key in xray_map.keys():
        xray_aliases[xray_key] = xray_key
        alt = _xray_alt_trace_id(xray_key)
        if alt:
            xray_aliases[alt] = xray_key

    # Now apply evaluator scores using aliases
    for trace_id, scores in evaluator_by_trace.items():
        canonical = trace_aliases.get(trace_id)
        if not canonical:
            normalized = _normalize_trace_id_for_xray(trace_id)
            canonical = trace_aliases.get(normalized) if normalized else None
        if canonical:
            traces[canonical]["evaluator_scores"] = scores

    # Now apply xray data using aliases and fix traces that missed xray lookup
    xray_match_count = 0
    xray_mismatch_count = 0
    for trace in traces.values():
        trace_id = trace.get("trace_id", "")
        if trace.get("xray", {}).get("subsegments"):
            xray_match_count += 1
            continue  # Already has xray data
        
        # Try direct lookup first
        if trace_id in xray_map:
            trace["xray"] = xray_map[trace_id]
            xray_match_count += 1
        else:
            # Try alternate formats
            alt = _xray_alt_trace_id(trace_id)
            if alt and alt in xray_map:
                trace["xray"] = xray_map[alt]
                xray_match_count += 1
            elif alt and alt in xray_aliases:
                xray_key = xray_aliases[alt]
                if xray_key in xray_map:
                    trace["xray"] = xray_map[xray_key]
                    xray_match_count += 1
                else:
                    xray_mismatch_count += 1
            else:
                xray_mismatch_count += 1

    sessions = defaultdict(list)
    for trace in traces.values():
        sessions[trace["session_id"]].append(trace)

    merged_sessions = {}
    for session_id, session_traces in sessions.items():
        sorted_traces = sorted(session_traces, key=lambda item: item.get("timestamp_epoch_ms", 0), reverse=True)
        latest = sorted_traces[0] if sorted_traces else {}

        e2e_values = [trace.get("stage_latency_ms", {}).get("e2e", 0) for trace in sorted_traces]
        error_count = len([trace for trace in sorted_traces if trace.get("status") != "success"])

        merged_sessions[session_id] = {
            "session_id": session_id,
            "latest_trace_ts": latest.get("timestamp_epoch_ms", 0),
            "latest_trace_timestamp_utc": latest.get("timestamp_utc", ""),
            "user": latest.get("user", {}),
            "trace_count": len(sorted_traces),
            "traces": sorted_traces,
            "session_metrics": {
                "avg_e2e_ms": sum(e2e_values) / max(len(e2e_values), 1),
                "max_e2e_ms": max(e2e_values) if e2e_values else 0,
                "error_rate": error_count / max(len(sorted_traces), 1),
                "delayed_rate": 0.0,
            },
        }

    return merged_sessions


# Trim the merged dataset to the user's requested scope.
def _apply_plan_scope(merged_sessions, plan):
    # Trim the merged dataset to the user's requested scope.
    target_sessions = set(plan.get("session_ids", []))
    raw_target_traces = {str(item).strip() for item in plan.get("trace_ids", []) if str(item).strip()}
    target_traces = set()
    for trace_id in raw_target_traces:
        target_traces.add(trace_id)
        normalized = _normalize_trace_id_for_xray(trace_id)
        if normalized:
            target_traces.add(normalized)
            target_traces.add(_xray_alt_trace_id(normalized))
        else:
            target_traces.add(_xray_alt_trace_id(trace_id))
    target_user_ids = {item.lower() for item in plan.get("user_ids", [])}
    target_user_names = {item.lower() for item in plan.get("user_names", [])}

    known_user_names = {
        str((session_data.get("user") or {}).get("user_name", "")).strip().lower()
        for session_data in merged_sessions.values()
        if str((session_data.get("user") or {}).get("user_name", "")).strip()
    }
    exact_user_targets = {name for name in target_user_names if name in known_user_names}

    def _trace_matches(trace):
        if target_traces:
            trace_id = str(trace.get("trace_id", "")).strip()
            trace_candidates = {trace_id}
            normalized = _normalize_trace_id_for_xray(trace_id)
            if normalized:
                trace_candidates.add(normalized)
                trace_candidates.add(_xray_alt_trace_id(normalized))
            else:
                trace_candidates.add(_xray_alt_trace_id(trace_id))

            if not any(candidate in target_traces for candidate in trace_candidates if candidate):
                return False

        if target_user_ids:
            user_id = str(trace.get("user", {}).get("user_id", "")).lower()
            if user_id not in target_user_ids:
                return False

        if target_user_names:
            user_name = str(trace.get("user", {}).get("user_name", "")).lower()
            if exact_user_targets:
                if user_name not in exact_user_targets:
                    return False
            elif not any(name in user_name or user_name in name for name in target_user_names):
                return False

        return True

    scoped = {}
    for session_id, session_data in merged_sessions.items():
        if target_sessions and session_id not in target_sessions:
            continue

        traces = [trace for trace in session_data.get("traces", []) if _trace_matches(trace)]
        if not traces and (target_sessions or target_traces or target_user_ids or target_user_names):
            continue

        copied = dict(session_data)
        copied["traces"] = traces if traces else session_data.get("traces", [])
        copied["trace_count"] = len(copied["traces"])
        scoped[session_id] = copied

    # If the user explicitly filtered (trace/session/user), keep empty scope when nothing matches.
    explicit_filters = bool(target_sessions or target_traces or target_user_ids or target_user_names)
    if explicit_filters:
        return scoped

    return scoped if scoped else merged_sessions


# Assemble the compact model context from runtime and evaluator data.
def _build_model_context(start_ms, end_ms, runtime_events, evaluator_events, merged_sessions, plan):
    detail_map = {"low": 3, "medium": 8, "high": 20}
    max_traces_per_session = detail_map.get(plan.get("detail_level", "medium"), 8)

    # Keep prompt payload compact for broad listing requests while still model-driven.
    intent_type = str(plan.get("intent_type", "")).lower()
    metrics_focus = {str(item).lower() for item in (plan.get("metrics_focus") or [])}
    if intent_type == "listing" and "session_ids" in metrics_focus:
        max_traces_per_session = 0

    scoped_sessions = _apply_plan_scope(merged_sessions, plan)
    compact_sessions = {}
    all_session_ids = sorted(scoped_sessions.keys())
    users_index = {}
    session_rows = []
    trace_rows = []

    for session_id, session_data in scoped_sessions.items():
        traces = session_data.get("traces", [])[:max_traces_per_session] if max_traces_per_session > 0 else []
        user_data = session_data.get("user", {}) or {}
        user_key = str(user_data.get("user_name") or user_data.get("user_id") or "unknown").lower()
        if user_key not in users_index:
            users_index[user_key] = {
                "user_name": user_data.get("user_name", "unknown"),
                "user_id": user_data.get("user_id", "unknown"),
                "department": user_data.get("department", "unknown"),
                "user_role": user_data.get("user_role", "unknown"),
                "session_ids": [],
            }
        users_index[user_key]["session_ids"].append(session_id)

        compact_sessions[session_id] = {
            "session_id": session_id,
            "latest_trace_ts": session_data.get("latest_trace_ts", 0),
            "latest_trace_timestamp_utc": session_data.get("latest_trace_timestamp_utc", ""),
            "user": session_data.get("user", {}),
            "trace_count": session_data.get("trace_count", 0),
            "session_metrics": session_data.get("session_metrics", {}),
            "traces": traces,
        }

        session_rows.append(
            {
                "session_id": session_id,
                "user_name": user_data.get("user_name", "unknown"),
                "user_id": user_data.get("user_id", "unknown"),
                "trace_count": session_data.get("trace_count", 0),
                "latest_timestamp_utc": session_data.get("latest_trace_timestamp_utc", ""),
            }
        )

        for trace in session_data.get("traces", []):
            trace_rows.append(
                {
                    "trace_id": trace.get("trace_id", ""),
                    "session_id": session_id,
                    "user_name": user_data.get("user_name", "unknown"),
                    "timestamp_utc": trace.get("timestamp_utc", ""),
                }
            )

    users_all = list(users_index.values())

    return {
        "analysis_request": {
            "intent_type": plan.get("intent_type"),
            "data_scope": plan.get("data_scope"),
            "lookback_hours": plan.get("lookback_hours"),
            "detail_level": plan.get("detail_level"),
            "entities": {
                "session_ids": plan.get("session_ids", []),
                "trace_ids": plan.get("trace_ids", []),
                "user_ids": plan.get("user_ids", []),
                "user_names": plan.get("user_names", []),
            },
            "metrics_focus": plan.get("metrics_focus", []),
        },
        "window": {
            "start_epoch_ms": start_ms,
            "end_epoch_ms": end_ms,
            "duration_minutes": int((end_ms - start_ms) / (1000 * 60)),
        },
        "source_counts": {
            "runtime_events": len(runtime_events),
            "evaluator_events": len(evaluator_events),
            "scoped_sessions": len(compact_sessions),
        },
        "session_ids_all": all_session_ids,
        "users_all": users_all,
        "user_match_hints": _build_user_match_hints(plan, users_all),
        "session_rows": session_rows,
        "trace_rows": trace_rows,
        "runtime_log_stream": RUNTIME_LOG_STREAM,
        "sessions": compact_sessions,
    }


# Pick the right context slice for the model prompt.
def _context_for_model_prompt(model_context, plan):
    intent = str(plan.get("intent_type", "")).lower()
    metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}

    base = {
        "analysis_request": model_context.get("analysis_request", {}),
        "window": model_context.get("window", {}),
        "source_counts": model_context.get("source_counts", {}),
        "session_ids_all": model_context.get("session_ids_all", []),
        "users_all": model_context.get("users_all", []),
        "user_match_hints": model_context.get("user_match_hints", []),
    }

    if intent == "listing" and "session_ids" in metrics:
        base["session_rows"] = model_context.get("session_rows", [])
        return base

    if intent == "listing" and "trace_ids" in metrics:
        base["trace_rows"] = model_context.get("trace_rows", [])
        return base

    if intent == "summary":
        session_rows = model_context.get("session_rows", [])
        base["session_rows"] = session_rows
        base["top_recent_sessions"] = session_rows[:20]
        return base

    base["sessions"] = model_context.get("sessions", {})
    return base


# Build the model-facing answer prompt for a question.
def _answer_prompt(question, context_json, conversation=None):
    # Safely serialize context to avoid mid-JSON truncation; prioritize analysis_request + window + metadata.
    context_safe = dict(context_json)
    full_json_bytes = len(json.dumps(context_safe, ensure_ascii=True))
    if full_json_bytes > 38000:
        # Trim sessions for large payloads to preserve metadata and listings.
        if "sessions" in context_safe and isinstance(context_safe["sessions"], dict):
            sessions = context_safe["sessions"]
            if len(sessions) > 10:
                context_safe["sessions"] = dict(list(sessions.items())[:10])
            context_safe["sessions_truncated"] = True
    
    context_str = json.dumps(context_safe, ensure_ascii=True)[:42000]
    if len(context_str) < len(json.dumps(context_safe, ensure_ascii=True)):
        context_str += "\n ...context truncated due to size limits. Use session_ids_all and rows for complete data."
    
    analysis_request = context_json.get("analysis_request", {}) if isinstance(context_json, dict) else {}
    intent = str(analysis_request.get("intent_type", "")).lower()
    metrics = {str(item).lower() for item in (analysis_request.get("metrics_focus") or [])}

    if intent == "summary":
        response_style = (
            "Response constraints: keep under 120 words. "
            "Use markdown with one short heading and up to 4 compact bullets."
        )
    elif intent == "listing" and ("session_ids" in metrics or "trace_ids" in metrics):
        response_style = (
            "Response constraints: list-only markdown output. "
            "Use compact numbered rows and avoid narrative unless explicitly asked."
        )
    elif intent in {"deep_dive", "comparison", "anomaly"}:
        response_style = (
            "Response constraints: keep under 220 words. "
            "Use markdown with concise sections, prioritize key evidence and one next action."
        )
    else:
        response_style = "Response constraints: keep under 160 words, concise markdown output."

    return (
        "You are Sensei Analyzer. For analysis questions, answer from the provided context data. "
        "If requested information is missing, clearly say what field/entity is missing. "
        "For general conversation (greetings, small talk, broad non-data questions), respond naturally and briefly. "
        "Interpret vague non-technical requests by user intent, not exact phrasing. "
        "When the user asks for more info, activity, sessions, history, or recent work about a person, give the most useful session-focused answer available from the context. "
        "If user asks 'show prompt suggestions' or asks what they can ask, provide 8-12 practical example prompts. "
        "Include examples for: summaries, users, sessions, trace deep dives, evaluator metrics, xray subsegments, comparisons, and timeframe changes. "
        "Return GitHub-flavored markdown. Do not use markdown tables. "
        "Write in clear, professional business language for non-technical readers. Keep it concise and directly useful. "
        "No emojis. Use short paragraphs and short bullet points only when they improve readability. "
        "Preferred format for analysis answers: 1) one-line summary, 2) key numbers, 3) notable observations, 4) optional next action. "
        "For list-style requests, provide complete lists using session_ids_all, session_rows, trace_rows, and users_all. "
        "When listing session IDs, include: user_name, trace_count, and latest_timestamp_utc for each session. "
        "When listing trace IDs, include: user_name, session_id, trace_id, and timestamp_utc for each trace. "
        "When listing users, include: user_name, user_id, and session_count for each user. "
        "When the user refers to an ordinal like 1st, 2nd, 3rd, 19th, or says 'the 19th session' after a paginated list, resolve it against the most recently shown page in the conversation. "
        "If the conversation explicitly mentions a page number, use that page and that page only. "
        "Do not jump to the closest timestamp or the closest matching user when an ordinal reference is present. "
        "First map the ordinal to the exact row in the visible list, then use that row's session_id or trace_id. "
        "When mentioning any ID (session_id, trace_id, request_id, user_id), always output the full exact ID value from context. "
        "Never shorten IDs to prefixes (for example, first 5-8 characters), never use ellipses, and never paraphrase IDs. "
        "If analysis_request.entities.user_names contains one or more names, report strictly on those exact user_name values (case-insensitive). "
        "Do not include similarly named users (for example, nikhil-test when user is nikhil) unless the user explicitly asks to compare or include related accounts. "
        "For session-id and trace-id listings, use compact numbered one-line records so all rows can fit. "
        "Preferred styles: '1) <session_id> - user: <name>, traces: <n>, latest: <YYYY-MM-DD HH:MM UTC>' "
        "and '1) <trace_id> - session: <session_id>, user: <name>, time: <YYYY-MM-DD HH:MM UTC>'. "
        "Do not add long narrative paragraphs for pure listing requests. "
        "When both total sessions and runtime events are shown, explicitly state that sessions are unique conversation IDs while runtime events are individual requests, so counts are not expected to match. "
        "Avoid long dumps of IDs unless user explicitly asks for all IDs. "
        "If question asks for a specific user and user_match_hints indicates ambiguous partial matches, ask a short clarification question listing candidates and wait for confirmation. "
        "If no user is matched, say so clearly and suggest 2-5 closest usernames from users_all. "
        "For list requests, use session_ids_all and users_all to provide complete lists. "
        "For follow-up requests like 'get more info on the 19th', keep the currently visible list in mind and pick the row at that ordinal from the latest page. "
        "Be concise and structured. "
        f"{response_style}\n\n"
        f"Conversation context:\n{_conversation_block(conversation)}\n\n"
        f"User question:\n{question}\n\n"
        f"Analyzer context JSON:\n{context_str}"
    )


# Build a lightweight prompt for general conversation that does not require data fetching.
def _general_conversation_prompt(question, conversation=None):
    return (
        "You are Sensei Analyzer, but the user is not asking for telemetry data. "
        "Handle the message as a normal, friendly conversation. "
        "Reply naturally, briefly, and without mentioning logs, sessions, or trace data unless the user asks for them. "
        "If the user is greeting you, greet them back. If they ask a broad non-data question, answer concisely and keep the conversation open-ended. "
        "Return concise markdown only (no JSON, no markdown tables).\n\n"
        f"Conversation context:\n{_conversation_block(conversation)}\n\n"
        f"User message:\n{question}"
    )


# Build hints for ambiguous user-name lookups.
def _build_user_match_hints(plan, users_all):
    requested_names = [str(item).strip().lower() for item in (plan.get("user_names") or []) if str(item).strip()]
    known_names = [str(item.get("user_name", "")).strip() for item in users_all if str(item.get("user_name", "")).strip()]

    hints = []
    for requested in requested_names:
        exact = [name for name in known_names if name.lower() == requested]
        partial = [name for name in known_names if requested and requested in name.lower()]
        partial = list(dict.fromkeys(partial))[:8]

        status = "none"
        if len(exact) == 1:
            status = "exact"
        elif len(partial) == 1:
            status = "single_partial"
        elif len(partial) > 1:
            status = "ambiguous_partial"

        hints.append(
            {
                "requested": requested,
                "status": status,
                "exact_matches": exact,
                "partial_matches": partial,
            }
        )

    return hints


# Return a clarification prompt when a requested user name matches multiple candidates.
def _user_ambiguity_clarification(plan, model_context):
    requested_names = [str(item).strip() for item in (plan.get("user_names") or []) if str(item).strip()]
    if not requested_names:
        return ""

    hints = model_context.get("user_match_hints", []) or []
    if not hints:
        return ""

    lines = []
    for hint in hints:
        status = str(hint.get("status", "")).strip().lower()
        if status != "ambiguous_partial":
            continue

        requested = str(hint.get("requested", "")).strip()
        candidates = hint.get("partial_matches") or hint.get("exact_matches") or []
        candidates = [str(item).strip() for item in candidates if str(item).strip()]
        if len(candidates) < 2:
            continue

        preview = ", ".join(candidates[:6])
        lines.append(f"- '{requested}' matches multiple users: {preview}")

    if not lines:
        return ""

    return (
        "I found multiple matching users. Please confirm the exact username before I continue.\n"
        + "\n".join(lines)
        + "\nReply with one exact username, for example: nikhil or nikhil-test."
    )


# Choose a query limit based on the requested detail level.
def _dynamic_query_limit(plan):
    detail = plan.get("detail_level", "medium")
    if detail == "low":
        return min(ANALYZER_MAX_QUERY_RESULTS, 1200)
    if detail == "high":
        return min(ANALYZER_MAX_QUERY_RESULTS, 5000)
    return min(ANALYZER_MAX_QUERY_RESULTS, 3000)


# Check whether the plan is asking for a list response.
def _is_listing_intent(plan):
    intent = str(plan.get("intent_type", "")).lower()
    if intent != "listing":
        return False
    metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}
    return "session_ids" in metrics or "trace_ids" in metrics


# Decide when evaluator logs should be fetched for the current plan.
def _should_fetch_evaluator(plan):
    intent = str(plan.get("intent_type", "")).lower()
    metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}

    # Explicit trace targets should include evaluator scores whenever possible.
    if plan.get("trace_ids"):
        return True

    if intent == "listing":
        if any(token in metric for metric in metrics for token in ("evaluator", "score", "quality")):
            return True
        return False

    # Deep dives on explicit entities should include evaluator evidence when available.
    if intent == "deep_dive" and (plan.get("trace_ids") or plan.get("session_ids")):
        return True

    # Respect evaluator-oriented planner hints.
    if any(token in metric for metric in metrics for token in ("evaluator", "score", "quality")):
        return True

    # Keep existing non-listing behavior for broader analysis modes.
    return intent in {"summary", "comparison", "deep_dive", "anomaly", "other"}


# Identify deep-dive requests that target a specific trace or session.
def _is_targeted_deep_dive(plan):
    intent = str(plan.get("intent_type", "")).lower()
    return intent == "deep_dive" and bool(plan.get("trace_ids") or plan.get("session_ids"))


# Format the lookback window as a compact label.
def _timeframe_label(lookback_hours):
    hours = int(max(1, lookback_hours))
    if hours % 24 == 0:
        return f"{hours // 24}d"
    return f"{hours}h"


# Encode pagination state for the next websocket request.
def _encode_continuation_token(state):
    raw = json.dumps(state, ensure_ascii=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


# Decode pagination state from an incoming websocket request.
def _decode_continuation_token(token):
    if not token:
        return {}
    try:
        raw = base64.urlsafe_b64decode(str(token).encode("ascii"))
        value = json.loads(raw.decode("utf-8"))
        if isinstance(value, dict):
            return value
    except Exception:
        return {}
    return {}


# Choose the page size for session or trace listings.
def _listing_page_size(rows_key):
    return 30 if rows_key == "session_rows" else 45


# Build one listing page and its continuation token metadata.
def _prepare_listing_page(prompt_context, plan, offset=0, page_size=None):
    # Paginate large listings so the websocket response stays usable.
    rows_key = _listing_rows_key(plan)
    if not rows_key:
        return None

    rows = prompt_context.get(rows_key, []) or []
    if not rows:
        return None

    effective_page_size = int(page_size or _listing_page_size(rows_key))
    start = max(0, int(offset))
    end = min(start + effective_page_size, len(rows))
    page_rows = rows[start:end]
    total_rows = len(rows)
    total_pages = max(1, (total_rows + effective_page_size - 1) // effective_page_size)
    page_number = min(total_pages, (start // effective_page_size) + 1)

    page_context = dict(prompt_context)
    page_context[rows_key] = page_rows
    page_context["pagination"] = {
        "page": page_number,
        "total_pages": total_pages,
        "page_row_count": len(page_rows),
        "rows_key": rows_key,
    }

    next_offset = end if end < total_rows else None
    return {
        "rows_key": rows_key,
        "page_context": page_context,
        "page_number": page_number,
        "total_pages": total_pages,
        "total_rows": total_rows,
        "next_offset": next_offset,
        "page_size": effective_page_size,
    }


def _format_timestamp_utc(value):
    text = str(value or "").strip()
    if not text:
        return "n/a"
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except Exception:
        return text


# Shared fallback renderer to avoid duplicate timeout paths.
def _render_timeout_fallback(plan, model_context, question, listing_page=None):
    if listing_page:
        rows_key = listing_page.get("rows_key")
        page_context = listing_page.get("page_context", {}) if isinstance(listing_page, dict) else {}
        rows = page_context.get(rows_key, []) if isinstance(page_context, dict) else []
        page = listing_page.get("page_number", 1)
        total_pages = listing_page.get("total_pages", 1)
        total_rows = listing_page.get("total_rows", len(rows))

        if rows_key == "trace_rows":
            lines = [f"### Page {page} of {total_pages} - Trace IDs ({total_rows} total)", ""]
            for index, row in enumerate(rows, start=1):
                lines.append(
                    f"{index}. **trace_id:** {row.get('trace_id', '')} - **session:** {row.get('session_id', '')}, **user:** {row.get('user_name', 'unknown')}, **time:** {_format_timestamp_utc(row.get('timestamp_utc', ''))}"
                )
            return "\n".join(lines)

        lines = [f"### Page {page} of {total_pages} - Session IDs ({total_rows} total)", ""]
        for index, row in enumerate(rows, start=1):
            lines.append(
                f"{index}. **session_id:** {row.get('session_id', '')} - **user:** {row.get('user_name', 'unknown')}, **traces:** {row.get('trace_count', 0)}, **latest:** {_format_timestamp_utc(row.get('latest_timestamp_utc', ''))}"
            )
        return "\n".join(lines)

    intent = str(plan.get("intent_type", "")).lower()
    trace_targets = [str(item).strip() for item in (plan.get("trace_ids") or []) if str(item).strip()]
    sessions = model_context.get("sessions", {}) or {}

    if trace_targets:
        target_set = set()
        for trace_id in trace_targets:
            target_set.add(trace_id)
            normalized = _normalize_trace_id_for_xray(trace_id)
            if normalized:
                target_set.add(normalized)
                target_set.add(_xray_alt_trace_id(normalized))
            else:
                target_set.add(_xray_alt_trace_id(trace_id))

        for session in sessions.values():
            for trace in session.get("traces", []) or []:
                trace_id = str(trace.get("trace_id", ""))
                trace_candidates = {trace_id}
                normalized = _normalize_trace_id_for_xray(trace_id)
                if normalized:
                    trace_candidates.add(normalized)
                    trace_candidates.add(_xray_alt_trace_id(normalized))
                else:
                    trace_candidates.add(_xray_alt_trace_id(trace_id))

                if not any(candidate in target_set for candidate in trace_candidates if candidate):
                    continue
                user = trace.get("user", {}) or {}
                xray = trace.get("xray", {}) or {}
                metrics = trace.get("evaluator_scores", {}) or {}
                subsegments = xray.get("subsegments", []) or []
                top = sorted(subsegments, key=lambda item: item.get("duration_ms", 0), reverse=True)[:5]
                lines = [
                    f"### Trace summary for {trace_id}",
                    f"- Session: {trace.get('session_id', 'n/a')}",
                    f"- User: {user.get('user_name', 'unknown')} ({user.get('user_id', 'unknown')})",
                    f"- Status: {trace.get('status', 'unknown')}",
                    f"- Time: {_format_timestamp_utc(trace.get('timestamp_utc', ''))}",
                    f"- End-to-end latency: {round(float(trace.get('stage_latency_ms', {}).get('e2e', 0) or 0), 2)} ms",
                    f"- X-Ray duration: {round(float(xray.get('duration_ms', 0) or 0), 2)} ms",
                    f"- Evaluator metrics available: {len(metrics)}",
                ]
                if metrics:
                    lines.append(
                        "- Metric scores: " + ", ".join(
                            f"{name}={payload.get('score', 0)}" for name, payload in list(metrics.items())[:6]
                        )
                    )
                if top:
                    lines.append("- Top subsegments:")
                    for index, item in enumerate(top, start=1):
                        lines.append(
                            f"  {index}. {item.get('name', 'unknown')} ({round(float(item.get('duration_ms', 0) or 0), 2)} ms)"
                        )
                lines.append("- Note: This is a timeout fallback response generated without Bedrock narration.")
                return "\n".join(lines)

    return (
        "Analysis timed out while generating a narrative response.\n"
        f"- Intent: {intent or 'unknown'}\n"
        f"- Sessions available: {len(model_context.get('session_ids_all', []))}\n"
        f"- Runtime events: {model_context.get('source_counts', {}).get('runtime_events', 0)}\n"
        f"- Evaluator events: {model_context.get('source_counts', {}).get('evaluator_events', 0)}\n"
        "Please retry for a richer model-written explanation."
    )


# Detect whether a model-generated listing page appears complete.
def _is_listing_page_answer_complete(answer_text, expected_rows):
    if expected_rows <= 0:
        return True

    text = str(answer_text or "")
    if not text.strip():
        return False

    item_lines = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        dot_pos = line.find(".")
        paren_pos = line.find(")")
        split_pos = -1
        if dot_pos > 0 and paren_pos > 0:
            split_pos = min(dot_pos, paren_pos)
        elif dot_pos > 0:
            split_pos = dot_pos
        elif paren_pos > 0:
            split_pos = paren_pos

        if split_pos > 0 and line[:split_pos].isdigit():
            item_lines += 1

    return item_lines >= max(1, int(expected_rows * 0.9))


# Identify whether the plan wants sessions or trace rows.
def _listing_rows_key(plan):
    metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}
    if "trace_ids" in metrics:
        return "trace_rows"
    if "session_ids" in metrics:
        return "session_rows"
    return ""


def _generation_status_label(plan):
    intent = str(plan.get("intent_type", "")).lower()
    rows_key = _listing_rows_key(plan)

    if intent == "listing" and rows_key == "session_rows":
        return "Preparing session list"
    if intent == "listing" and rows_key == "trace_rows":
        return "Preparing trace list"
    if intent == "summary":
        return "Generating summary"
    if intent in {"deep_dive", "anomaly"}:
        return "Preparing deep analysis"
    if intent == "comparison":
        return "Preparing comparison"
    return "Generating response"


# Fetch X-Ray only when the inferred analysis intent actually needs trace internals.
def _should_fetch_xray(plan):
    intent = str(plan.get("intent_type", "")).lower()
    scope = str(plan.get("data_scope", "")).lower()
    detail = str(plan.get("detail_level", "")).lower()
    metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}

    # Explicit trace targets always require X-Ray enrichment.
    if plan.get("trace_ids"):
        return True
    if scope == "trace_window":
        return True

    # Session deep-dives without explicit trace targets do not need heavy X-Ray payloads.
    if scope == "session_window" and not plan.get("trace_ids"):
        return False

    # Deep investigations can benefit from segment-level evidence.
    if intent in {"deep_dive", "anomaly"}:
        return True

    # Comparison mode may need extra depth only for higher detail plans.
    if intent == "comparison" and detail in {"medium", "high"}:
        return True

    # Respect explicit trace-oriented metrics if planner emits them.
    if {"trace_ids", "xray", "subsegments", "latency"} & metrics:
        return True

    return False


# Detect plain user-listing questions and route them to deterministic listing output.
# Handle WebSocket lifecycle events and analyzer chat requests.
def lambda_handler(event, _context):
    # Handle WebSocket lifecycle events and analyzer chat requests.
    start_time_epoch = time.time()
    route_key = event.get("requestContext", {}).get("routeKey")

    if route_key in {"$connect", "$disconnect"}:
        return {"statusCode": 200, "body": "ok"}

    payload = _parse_body(event)
    request_id = payload.get("requestId")
    _audit(
        "request_received",
        request_id,
        route_key=route_key,
        action=payload.get("action"),
        session_id=payload.get("sessionId"),
        prompt_preview=str(payload.get("prompt", ""))[:800],
    )

    if route_key == "$default" and payload.get("action") not in {"analyzer", "observability_evaluation"}:
        _post_to_connection(
            event,
            {
                "type": "error",
                "message": "Use action=observability_evaluation for Observability & Evaluation chat",
            },
        )
        return {"statusCode": 200, "body": "ignored"}

    continuation_token = payload.get("continuationToken")
    continuation_state = _decode_continuation_token(continuation_token)
    is_continuation = bool(continuation_state)

    question = str(
        continuation_state.get("question") if is_continuation else payload.get("prompt", "")
    ).strip()
    conversation = _normalize_conversation(payload.get("conversation"))
    if not question:
        _post_to_connection(
            event,
            {
                "type": "error",
                "requestId": request_id,
                "message": "Prompt is required",
            },
        )
        return {"statusCode": 200, "body": "validation_error"}

    requested_lookback = _parse_lookback_hours(
        continuation_state.get("lookback_hours") if is_continuation else payload.get("lookbackHours"),
        DEFAULT_ANALYSIS_LOOKBACK_HOURS,
    )

    try:
        if is_continuation:
            plan = continuation_state.get("plan") if isinstance(continuation_state.get("plan"), dict) else {}
            plan = _normalize_plan(question, plan, requested_lookback)
            _audit(
                "continuation_loaded",
                request_id,
                offset=continuation_state.get("offset", 0),
                page_size=continuation_state.get("page_size"),
            )
        else:
            plan = _infer_analysis_plan(question, requested_lookback, start_time_epoch, conversation=conversation)
            _audit(
                "plan_inferred",
                request_id,
                lookback_hours=plan.get("lookback_hours"),
                intent_type=plan.get("intent_type"),
                data_scope=plan.get("data_scope"),
                detail_level=plan.get("detail_level"),
                session_ids=plan.get("session_ids", []),
                trace_ids=plan.get("trace_ids", []),
                user_ids=plan.get("user_ids", []),
                user_names=plan.get("user_names", []),
                metrics_focus=plan.get("metrics_focus", []),
            )

        # Recover trace IDs directly from user text when planner misses them.
        if not plan.get("trace_ids"):
            inferred_trace_ids = _extract_trace_ids_from_text(question)
            if inferred_trace_ids:
                plan["trace_ids"] = inferred_trace_ids
                if str(plan.get("data_scope", "")).lower() in {"", "none", "fleet_window"}:
                    plan["data_scope"] = "trace_window"
                if str(plan.get("intent_type", "")).lower() == "listing":
                    plan["intent_type"] = "deep_dive"
                metrics_focus = [str(item).lower() for item in (plan.get("metrics_focus") or [])]
                if "trace_ids" not in metrics_focus:
                    metrics_focus.append("trace_ids")
                plan["metrics_focus"] = metrics_focus
                _audit(
                    "trace_ids_inferred_from_question",
                    request_id,
                    trace_ids=inferred_trace_ids,
                )

        intent = str(plan.get("intent_type", "")).lower()
        if intent == "general_conversation":
            _audit(
                "general_conversation_short_circuit",
                request_id,
                question_preview=question[:200],
            )
            general_status_payload = {
                "mode": "analyzer",
                "requestId": request_id,
                "sessionId": payload.get("sessionId"),
            }
            _post_status_update(event, general_status_payload, "Generating response")
            try:
                answer = _converse_text_with_timeout(
                    start_time_epoch,
                    _general_conversation_prompt(question, conversation=conversation),
                    max_tokens=180,
                    temperature=0.4,
                )
            except TimeoutError:
                answer = "Hello. I can help with analysis questions or general chat."
            except Exception as exc:
                message = str(exc).lower()
                if "serviceunavailableexception" in message or "too many connections" in message:
                    answer = "Hello. I can help with analysis questions or general chat."
                else:
                    raise

            _post_assistant_response(
                event,
                {
                    "type": "assistant_response",
                    "mode": "analyzer",
                    "status": "success",
                    "requestId": request_id,
                    "sessionId": payload.get("sessionId"),
                    "answer": answer,
                    "timeframeLabel": _timeframe_label(requested_lookback),
                    "analysisMeta": {
                        "analysis_request": {
                            "intent_type": intent,
                            "data_scope": plan.get("data_scope"),
                            "lookback_hours": plan.get("lookback_hours"),
                            "detail_level": plan.get("detail_level"),
                        },
                        "window": {
                            "start_epoch_ms": 0,
                            "end_epoch_ms": 0,
                            "duration_minutes": 0,
                        },
                        "source_counts": {
                            "runtime_events": 0,
                            "evaluator_events": 0,
                        },
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            _audit("response_sent", request_id, status="success", intent_type=intent)
            return {"statusCode": 200, "body": "ok"}

        lookback_hours = int(plan.get("lookback_hours", requested_lookback))
        end_time = datetime.now(timezone.utc)
        start_time = end_time - timedelta(hours=lookback_hours)
        end_ms = int(end_time.timestamp() * 1000)
        start_ms = int(start_time.timestamp() * 1000)

        base_response_payload = {
            "type": "assistant_response",
            "mode": "analyzer",
            "status": "success",
            "requestId": request_id,
            "sessionId": payload.get("sessionId"),
            "timeframeLabel": _timeframe_label(lookback_hours),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        remaining_for_queries = max(2.0, min(9.0, _seconds_left(start_time_epoch) - 8.0))
        query_limit = _dynamic_query_limit(plan)
        listing_mode = _is_listing_intent(plan)
        targeted_deep_dive = _is_targeted_deep_dive(plan)
        fetch_evaluator = _should_fetch_evaluator(plan)
        trace_targeted_listing = listing_mode and bool(plan.get("trace_ids"))
        summary_mode = str(plan.get("intent_type", "")).lower() == "summary"

        if targeted_deep_dive:
            # Keep data fetch tightly bounded so targeted deep dives still have time for narrative generation.
            remaining_for_queries = max(1.5, min(4.5, _seconds_left(start_time_epoch) - 10.0))
            query_limit = min(query_limit, 800)
        elif summary_mode and not plan.get("trace_ids") and not plan.get("session_ids") and not plan.get("user_names") and not plan.get("user_ids"):
            # Fleet-wide summaries do not need maximum evaluator event breadth.
            query_limit = min(query_limit, 300)

        # Log data collection strategy based on intent
        _audit(
            "data_collection_strategy_selected",
            request_id,
            intent_type=plan.get("intent_type"),
            listing_mode=listing_mode,
            targeted_deep_dive=targeted_deep_dive,
            will_fetch_runtime=True,
            will_fetch_evaluator=fetch_evaluator,
            will_fetch_xray="pending_intent_check",
            detail_level=plan.get("detail_level"),
            metrics_focus=plan.get("metrics_focus", []),
        )

        _post_status_update(event, base_response_payload, "Collecting logs")
        if listing_mode and not trace_targeted_listing:
            runtime_events = _fetch_runtime_events(start_ms, end_ms, remaining_for_queries, query_limit)
            evaluator_events = []
        elif targeted_deep_dive and not fetch_evaluator:
            runtime_events = _fetch_runtime_events(start_ms, end_ms, remaining_for_queries, query_limit)
            evaluator_events = []
        else:
            with ThreadPoolExecutor(max_workers=2) as executor:
                runtime_future = executor.submit(
                    _fetch_runtime_events,
                    start_ms,
                    end_ms,
                    remaining_for_queries,
                    query_limit,
                )
                evaluator_future = executor.submit(
                    _fetch_evaluator_events,
                    start_ms,
                    end_ms,
                    remaining_for_queries,
                    query_limit,
                ) if fetch_evaluator else None
                runtime_events = runtime_future.result(timeout=max(1.0, remaining_for_queries + 1.0))
                evaluator_events = (
                    evaluator_future.result(timeout=max(1.0, remaining_for_queries + 1.0))
                    if evaluator_future is not None
                    else []
                )

        _post_status_update(event, base_response_payload, "Merging telemetry")

        _audit(
            "events_loaded",
            request_id,
            runtime_events=len(runtime_events),
            evaluator_events=len(evaluator_events),
            query_limit=query_limit,
            lookback_hours=lookback_hours,
        )

        if (listing_mode and not trace_targeted_listing) or not _should_fetch_xray(plan):
            xray_map = {}
            _audit(
                "xray_skipped",
                request_id,
                reason="listing_or_not_required",
                intent_type=plan.get("intent_type"),
                data_scope=plan.get("data_scope"),
                detail_level=plan.get("detail_level"),
            )
        else:
            remaining_after_fetch = _seconds_left(start_time_epoch)
            max_subsegments = 40 if remaining_after_fetch > 8 else 20

            planned_trace_ids = [_normalize_trace_id_for_xray(item) for item in plan.get("trace_ids", [])]
            planned_trace_ids = [item for item in planned_trace_ids if item]
            question_trace_ids = _extract_trace_ids_from_text(question)

            explicit_trace_ids = []
            seen_explicit = set()
            for trace_id in planned_trace_ids + question_trace_ids:
                if trace_id and trace_id not in seen_explicit:
                    seen_explicit.add(trace_id)
                    explicit_trace_ids.append(trace_id)

            runtime_trace_ids = [item.get("xray_trace_id") for item in runtime_events if item.get("xray_trace_id")]
            runtime_trace_ids = [_normalize_trace_id_for_xray(item) for item in runtime_trace_ids]
            runtime_trace_ids = [item for item in runtime_trace_ids if item and item not in seen_explicit]

            xray_map = {}
            if explicit_trace_ids:
                _audit(
                    "xray_fetch_explicit",
                    request_id,
                    explicit_trace_ids_requested=explicit_trace_ids[:10],
                    explicit_trace_ids_count=len(explicit_trace_ids),
                )
                xray_map.update(
                    _fetch_xray_summaries(
                        explicit_trace_ids,
                        max_traces=max(len(explicit_trace_ids), 10),
                        max_subsegments=max_subsegments,
                    )
                )

            # Keep a bounded sample from runtime traces for overall context.
            runtime_budget = max(0, 25 - len(explicit_trace_ids))
            if runtime_budget > 0 and runtime_trace_ids:
                xray_map.update(
                    _fetch_xray_summaries(
                        runtime_trace_ids,
                        max_traces=runtime_budget,
                        max_subsegments=max_subsegments,
                    )
                )

            xray_entries = list(xray_map.values()) if isinstance(xray_map, dict) else []
            unique_trace_ids = {
                str(item.get("trace_id", "")).strip()
                for item in xray_entries
                if isinstance(item, dict) and str(item.get("trace_id", "")).strip()
            }
            total_subsegments = sum(
                len((item.get("subsegments") or []))
                for item in xray_entries
                if isinstance(item, dict)
            )

            # Log xray_map keys for debugging trace ID matching issues
            xray_map_keys = list(xray_map.keys()) if isinstance(xray_map, dict) else []
            
            _audit(
                "xray_loaded",
                request_id,
                explicit_trace_targets=len(explicit_trace_ids),
                runtime_trace_candidates=len(runtime_trace_ids),
                xray_unique_traces=len(unique_trace_ids),
                xray_subsegments_total=total_subsegments,
                xray_map_keys_sample=xray_map_keys[:20],  # First 20 keys for debugging
                xray_map_total_keys=len(xray_map_keys),
            )

        merged_sessions = _merge_events(runtime_events, evaluator_events, xray_map)
        model_context = _build_model_context(
            start_ms,
            end_ms,
            runtime_events,
            evaluator_events,
            merged_sessions,
            plan,
        )

        requested_trace_ids = {str(item).strip() for item in (plan.get("trace_ids") or []) if str(item).strip()}
        matched_requested_traces = 0
        matched_requested_with_evaluator = 0
        matched_requested_with_subsegments = 0
        total_evaluator_metrics = 0
        if requested_trace_ids:
            for session in model_context.get("sessions", {}).values():
                for trace in session.get("traces", []) or []:
                    trace_id = str(trace.get("trace_id", "")).strip()
                    if trace_id not in requested_trace_ids:
                        continue
                    matched_requested_traces += 1
                    evaluator_scores = trace.get("evaluator_scores", {})
                    if evaluator_scores:
                        matched_requested_with_evaluator += 1
                        total_evaluator_metrics += len(evaluator_scores)
                    if (trace.get("xray", {}) or {}).get("subsegments"):
                        matched_requested_with_subsegments += 1

            _audit(
                "trace_data_coverage",
                request_id,
                requested_trace_ids=list(requested_trace_ids),
                matched_requested_traces=matched_requested_traces,
                matched_with_evaluator=matched_requested_with_evaluator,
                matched_with_subsegments=matched_requested_with_subsegments,
                total_evaluator_metrics_found=total_evaluator_metrics,
            )

        _audit(
            "context_built",
            request_id,
            source_counts=model_context.get("source_counts", {}),
            session_count=len(model_context.get("session_ids_all", [])),
            users_count=len(model_context.get("users_all", [])),
        )

        _post_status_update(event, base_response_payload, _generation_status_label(plan))

        clarification = _user_ambiguity_clarification(plan, model_context)
        if clarification:
            _audit(
                "user_clarification_requested",
                request_id,
                requested_names=plan.get("user_names", []),
                hints=model_context.get("user_match_hints", []),
            )
            _post_assistant_response(
                event,
                {
                    "type": "assistant_response",
                    "mode": "analyzer",
                    "status": "success",
                    "requestId": request_id,
                    "sessionId": payload.get("sessionId"),
                    "answer": clarification,
                    "timeframeLabel": _timeframe_label(lookback_hours),
                    "analysisMeta": {
                        "analysis_request": model_context.get("analysis_request"),
                        "window": model_context.get("window"),
                        "source_counts": model_context.get("source_counts"),
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            _audit("response_sent", request_id, status="success", clarification=True)
            return {"statusCode": 200, "body": "ok"}

        if _seconds_left(start_time_epoch) < 3:
            raise TimeoutError("Analyzer time budget exceeded before answer generation")

        prompt_context = _context_for_model_prompt(model_context, plan)
        intent = str(plan.get("intent_type", "")).lower()
        metrics = {str(item).lower() for item in (plan.get("metrics_focus") or [])}

        # Keep answer budgets small by intent to reduce Bedrock latency/timeouts.
        prompt_base_tokens = len(json.dumps(prompt_context, ensure_ascii=True)) // 4
        if intent == "summary":
            max_tokens = 450
        elif intent == "listing" and ("session_ids" in metrics or "trace_ids" in metrics):
            row_count = len(prompt_context.get("session_rows", [])) + len(prompt_context.get("trace_rows", []))
            if row_count <= 60:
                max_tokens = 1200
            elif row_count <= 140:
                max_tokens = 1600
            else:
                max_tokens = 2200
        elif intent in {"deep_dive", "comparison", "anomaly"}:
            if targeted_deep_dive:
                max_tokens = 620
            else:
                max_tokens = 700 if not plan.get("trace_ids") else 900
        else:
            max_tokens = 900

        # Keep combined prompt budget conservative for consistent latency.
        max_tokens = max(450, min(max_tokens, max(450, 6000 - prompt_base_tokens)))

        # Log which context keys are being sent to the answer model (critical for demo)
        context_keys_sent = list(prompt_context.keys())
        context_has_sessions = "sessions" in context_keys_sent
        context_has_session_rows = "session_rows" in context_keys_sent
        context_has_trace_rows = "trace_rows" in context_keys_sent
        context_has_top_recent = "top_recent_sessions" in context_keys_sent
        context_payload_bytes = len(json.dumps(prompt_context, ensure_ascii=True))

        _audit(
            "context_sent_to_model",
            request_id,
            intent_type=intent,
            context_keys=context_keys_sent,
            has_full_sessions=context_has_sessions,
            has_session_rows=context_has_session_rows,
            has_trace_rows=context_has_trace_rows,
            has_top_recent_summary=context_has_top_recent,
            context_payload_bytes=context_payload_bytes,
            expected_answer_tokens=max_tokens,
        )

        _audit(
            "prompt_ready",
            request_id,
            prompt_context_chars=len(json.dumps(prompt_context, ensure_ascii=True)),
            max_tokens=max_tokens,
        )

        listing_page = _prepare_listing_page(
            prompt_context,
            plan,
            offset=continuation_state.get("offset", 0) if is_continuation else 0,
            page_size=continuation_state.get("page_size") if is_continuation else None,
        )
        if listing_page and listing_page.get("total_pages", 1) > 1:
            _audit(
                "auto_pagination_page",
                request_id,
                page=listing_page.get("page_number"),
                total_pages=listing_page.get("total_pages"),
                total_rows=listing_page.get("total_rows"),
            )

            page_number = listing_page.get("page_number")
            total_pages = listing_page.get("total_pages")
            page_context = listing_page.get("page_context")
            rows_key = listing_page.get("rows_key")
            page_question = (
                f"{question}\n"
                f"Return page {page_number} of {total_pages} only. "
                "Do not repeat rows from other pages."
            )
            try:
                page_answer = _converse_text_with_timeout(
                    start_time_epoch,
                    _answer_prompt(page_question, page_context, conversation=conversation),
                    max_tokens=850,
                    temperature=0.1,
                )

                page_rows = page_context.get(rows_key, []) if isinstance(page_context, dict) else []
                if not _is_listing_page_answer_complete(page_answer, len(page_rows)):
                    page_answer = _render_timeout_fallback(plan, model_context, question, listing_page=listing_page)
                    _audit(
                        "listing_incomplete_fallback_used",
                        request_id,
                        page=page_number,
                        rows_key=rows_key,
                        expected_rows=len(page_rows),
                    )
            except TimeoutError:
                page_answer = _render_timeout_fallback(plan, model_context, question, listing_page=listing_page)
                _audit("model_timeout_fallback_used", request_id, page=page_number, rows_key=rows_key)

            next_offset = listing_page.get("next_offset")
            next_token = None
            if next_offset is not None:
                # Limit plan entities to 100 items max to keep continuation token under ~4KB for WebSocket safety.
                limited_plan = dict(plan)
                for key in ["session_ids", "trace_ids", "user_ids", "user_names"]:
                    if key in limited_plan and isinstance(limited_plan[key], list):
                        limited_plan[key] = limited_plan[key][:100]
                next_token = _encode_continuation_token(
                    {
                        "v": 1,
                        "question": question,
                        "lookback_hours": lookback_hours,
                        "plan": limited_plan,
                        "offset": next_offset,
                        "page_size": listing_page.get("page_size"),
                    }
                )

            _post_assistant_response(
                event,
                {
                    "type": "assistant_response",
                    "mode": "analyzer",
                    "status": "success",
                    "requestId": request_id,
                    "sessionId": payload.get("sessionId"),
                    "answer": page_answer or f"No content for page {page_number}.",
                    "timeframeLabel": _timeframe_label(lookback_hours),
                    "continuationToken": next_token,
                    "pagination": {
                        "page": page_number,
                        "totalPages": total_pages,
                        "totalRows": listing_page.get("total_rows"),
                    },
                    "analysisMeta": {
                        "analysis_request": model_context.get("analysis_request"),
                        "window": model_context.get("window"),
                        "source_counts": model_context.get("source_counts"),
                        "pagination": {"page": page_number, "total_pages": total_pages},
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )

            _audit(
                "response_sent",
                request_id,
                status="success",
                paginated=True,
                page=page_number,
                total_pages=total_pages,
                has_next=bool(next_token),
            )
            return {"statusCode": 200, "body": "ok"}

        # Log final analysis request summary before invoking model
        _audit(
            "analysis_step_before_model_invoke",
            request_id,
            question_preview=question[:200],
            intent_classification=plan.get("intent_type"),
            data_scope=plan.get("data_scope"),
            entities_in_plan={
                "session_ids": plan.get("session_ids", []),
                "trace_ids": plan.get("trace_ids", []),
                "user_names": plan.get("user_names", []),
            },
            total_sessions_available=len(model_context.get("session_ids_all", [])),
            total_users_available=len(model_context.get("users_all", [])),
            runtime_events_loaded=model_context.get("source_counts", {}).get("runtime_events", 0),
            evaluator_events_loaded=model_context.get("source_counts", {}).get("evaluator_events", 0),
            context_shape={
                "analysis_request": "always",
                "window": "always",
                "source_counts": "always",
                "session_ids_all": "always",
                "users_all": "always",
                "user_match_hints": "always",
                "full_sessions": context_has_sessions,
                "session_rows": context_has_session_rows,
                "trace_rows": context_has_trace_rows,
                "top_recent_sessions": context_has_top_recent,
            },
        )

        try:
            base_response_payload["analysisMeta"] = {
                "analysis_request": model_context.get("analysis_request"),
                "window": model_context.get("window"),
                "source_counts": model_context.get("source_counts"),
            }

            stream_chunk_count = {"value": 0}

            def _emit_live_chunk(piece):
                if not piece:
                    return
                stream_chunk_count["value"] += 1
                _post_assistant_response_chunk(
                    event,
                    base_response_payload,
                    piece,
                    stream_chunk_count["value"],
                    0,
                )

            answer = _generate_answer_with_retry_streaming(
                start_time_epoch,
                question,
                prompt_context,
                conversation,
                max_tokens=max_tokens,
                temperature=0.2,
                on_text_chunk=_emit_live_chunk,
            )
        except TimeoutError:
            answer = _render_timeout_fallback(plan, model_context, question)
            _audit(
                "model_timeout_fallback_used",
                request_id,
                intent_type=plan.get("intent_type"),
                has_trace_targets=bool(plan.get("trace_ids")),
            )

        _audit(
            "model_answered",
            request_id,
            answer_chars=len(answer or ""),
            timeframe=_timeframe_label(lookback_hours),
            live_stream_chunks=stream_chunk_count.get("value", 0) if "stream_chunk_count" in locals() else 0,
        )

        if "stream_chunk_count" in locals() and stream_chunk_count.get("value", 0) > 0:
            if isinstance(answer, str) and "[Partial response due to" in answer:
                marker = answer[answer.find("[Partial response due to") :].strip()
                if marker:
                    _post_assistant_response_chunk(
                        event,
                        base_response_payload,
                        f"\n\n{marker}",
                        stream_chunk_count["value"] + 1,
                        0,
                    )
            _post_assistant_response_end(event, base_response_payload)
        else:
            _post_assistant_response(
                event,
                {
                    "type": "assistant_response",
                    "mode": "analyzer",
                    "status": "success",
                    "requestId": request_id,
                    "sessionId": payload.get("sessionId"),
                    "answer": answer or "No analyzer response returned",
                    "timeframeLabel": _timeframe_label(lookback_hours),
                    "analysisMeta": {
                        "analysis_request": model_context.get("analysis_request"),
                        "window": model_context.get("window"),
                        "source_counts": model_context.get("source_counts"),
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
        _audit("response_sent", request_id, status="success")
    except TimeoutError as exc:
        _audit("timeout", request_id, error=str(exc))
        _post_to_connection(
            event,
            {
                "type": "error",
                "mode": "analyzer",
                "requestId": request_id,
                "message": str(exc),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:
        LOGGER.exception("Analyzer lambda failed")
        _audit(
            "exception",
            request_id,
            error=str(exc),
            traceback=traceback.format_exc()[-5000:],
        )
        _post_to_connection(
            event,
            {
                "type": "error",
                "mode": "analyzer",
                "requestId": request_id,
                "message": str(exc),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )

    return {"statusCode": 200, "body": "ok"}
