FROM mcr.microsoft.com/playwright/python:v1.56.0-noble
WORKDIR /app
RUN pip install --no-cache-dir playwright==1.56.0
COPY scripts/hosted/probe.py scripts/hosted/service.py ./
USER pwuser
EXPOSE 10000
CMD ["python", "service.py"]
