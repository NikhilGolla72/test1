FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Install Python dependencies first for better layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

# Copy application code.
COPY . /app

# Start the AgentCore app.
CMD ["python", "my_agent1.py"]
