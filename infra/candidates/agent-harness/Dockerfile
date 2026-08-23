FROM public.ecr.aws/docker/library/python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
    PYTHONPATH=/app:/app/services/agent-service/src

RUN groupadd --gid 10002 opsmind \
    && useradd --uid 10002 --gid 10002 --create-home --home-dir /home/opsmind opsmind

# The product's protocol-lab connector uses a restricted SSH transport.  Keep
# only the client in the image; the container still has no shell credentials
# beyond the four read-only/action-scoped identities mounted at runtime.
RUN sed -i \
       -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
       -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
       /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::ForceIPv4=true \
       -o Acquire::Retries=3 \
       -o Acquire::http::Timeout=20 update \
    && DEBIAN_FRONTEND=noninteractive apt-get \
       -o Acquire::ForceIPv4=true \
       -o Acquire::Retries=3 \
       -o Acquire::http::Timeout=20 install -y --no-install-recommends \
       bubblewrap \
       openssh-client \
       socat \
    && rm -rf /var/lib/apt/lists/*

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
    && mkdir -p /app/test-workspaces/open-world-agent /home/opsmind/.claude \
    && chown -R 10002:10002 /app/test-workspaces /home/opsmind

USER 10002:10002

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=8 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

ENTRYPOINT ["/usr/local/bin/opsmind-agent-harness-entrypoint"]
