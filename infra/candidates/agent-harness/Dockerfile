FROM public.ecr.aws/docker/library/python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app:/app/services/agent-service/src

RUN groupadd --gid 10002 opsmind \
    && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/opsmind opsmind

WORKDIR /app

COPY services/agent-service /app/services/agent-service
COPY shared /app/shared
COPY docs/g3/results /app/docs/g3/results
COPY infra-candidate/entrypoint.sh /usr/local/bin/opsmind-agent-harness-entrypoint
COPY infra-candidate/wheels/claude_agent_sdk-0.2.142-py3-none-manylinux_2_17_x86_64.whl /tmp/claude_agent_sdk-0.2.142-py3-none-manylinux_2_17_x86_64.whl

RUN python -m pip install --upgrade pip \
    && python -m pip install /tmp/claude_agent_sdk-0.2.142-py3-none-manylinux_2_17_x86_64.whl \
    && python -m pip install /app/services/agent-service \
    && rm -f /tmp/claude_agent_sdk-0.2.142-py3-none-manylinux_2_17_x86_64.whl \
    && chmod 0755 /usr/local/bin/opsmind-agent-harness-entrypoint \
    && mkdir -p /app/test-workspaces/open-world-agent \
    && chown -R 10002:10002 /app/test-workspaces /home/opsmind

USER 10002:10002

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=8 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

ENTRYPOINT ["/usr/local/bin/opsmind-agent-harness-entrypoint"]
