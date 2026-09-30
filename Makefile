SHELL := /bin/bash
NVM_USE := source ~/.nvm/nvm.sh && nvm use --silent

.PHONY: start import import-slim test build deploy publish clear-short-cache clear-long-cache clear-all-cache cleanup-revisions smoke

PROJECT_ID ?= timetable-252615
IMAGE ?= gcr.io/$(PROJECT_ID)/timetable-api-node-sqlite
SERVICE_NAME ?= timetable-api-node
REGION ?= us-central1
DOCKER_PLATFORM ?= linux/amd64
# Keep in sync with _MEMORY in cloudbuild.yaml — 256Mi OOMs at startup.
MEMORY ?= 512Mi

# index.js logs the same URL on boot, but New Relic's connection chatter
# buries it — print it up front, before that noise, so it's the first thing
# on screen.
start:
	@bash -c 'set -a; [ -f .env ] && source .env; set +a; \
		echo ""; echo "==> http://localhost:$${PORT:-8080}"; echo ""'
	$(NVM_USE) && npm start

import:
	$(NVM_USE) && npm run import

import-slim:
	$(NVM_USE) && npm run import-slim

test:
	$(NVM_USE) && npm test

build:
	docker buildx build \
		--platform $(DOCKER_PLATFORM) \
		--build-arg CACHEBUST=$$(date +%s) \
		--tag $(IMAGE) \
		--push .

publish:
	$(NVM_USE) && npm version patch && git push --tags

deploy: build
	gcloud run deploy $(SERVICE_NAME) --image $(IMAGE) --region $(REGION) --platform managed --project $(PROJECT_ID) --memory $(MEMORY) --quiet

CF_CACHE_PURGE_URL := https://drop-cloudflare-cache-1041251696619.us-central1.run.app
SHORT_CACHE_TAGS ?= short
LONG_CACHE_TAGS ?= long

clear-short-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)?tags=$(SHORT_CACHE_TAGS)"

clear-long-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)?tags=$(LONG_CACHE_TAGS)"

clear-all-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)"

cleanup-revisions:
	./cleanup-revisions.sh

# Basic smoke tests against production. Arrays may be empty at night, so only
# shape is checked: HTTP 200, JSON array, and each item carries its key field.
SMOKE_URL ?= https://api.lad.lviv.ua

smoke:
	@curl -fsS "$(SMOKE_URL)/stops/60/timetable" \
		| jq -e 'type == "array" and all(.[]; has("route") and has("arrival_time"))' >/dev/null \
		&& echo "OK  /stops/60/timetable" || { echo "FAIL /stops/60/timetable"; exit 1; }
	@curl -fsS "$(SMOKE_URL)/routes/dynamic/A46" \
		| jq -e 'type == "array" and all(.[]; has("id") and has("location"))' >/dev/null \
		&& echo "OK  /routes/dynamic/A46" || { echo "FAIL /routes/dynamic/A46"; exit 1; }
