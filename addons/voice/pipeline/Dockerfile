# Voice ingest pipeline: Deepgram speech-to-text + task extraction.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY ingest/ ./ingest/
COPY bench.py ./
RUN useradd --system --uid 10001 ingest && mkdir -p /data && chown ingest /data
USER ingest
ENV DATA_DIR=/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "ingest.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
