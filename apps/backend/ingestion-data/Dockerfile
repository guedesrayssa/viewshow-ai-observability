FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

RUN apt-get update \
 && apt-get install --yes --no-install-recommends default-mysql-client=1.1.0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 ingestion

WORKDIR /app

ENV ARCHIVE_WORKDIR=/tmp/ingestion

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.txt

COPY domain ./domain
COPY application ./application
COPY ports ./ports
COPY adapters ./adapters
COPY bootstrap ./bootstrap
COPY contracts ./contracts
COPY scripts ./scripts

USER ingestion

# Task 21 runtime contract: read-only rootfs requires a writable volume mounted at /tmp.
# Do not model this as ECS linuxParameters.tmpfs, which Fargate does not support.
ENTRYPOINT ["python", "-m", "bootstrap"]
CMD ["--help"]
