SHELL := /bin/bash
NVM_USE := source ~/.nvm/nvm.sh && nvm use --silent

.PHONY: start import import-slim test build deploy clear-short-cache clear-long-cache clear-all-cache cleanup-revisions

PROJECT_ID ?= timetable-252615
IMAGE ?= gcr.io/$(PROJECT_ID)/timetable-api-node-sqlite
SERVICE_NAME ?= timetable-api-node
REGION ?= us-central1
DOCKER_PLATFORM ?= linux/amd64

start:
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

deploy: build
	gcloud run deploy $(SERVICE_NAME) --image $(IMAGE) --region $(REGION) --platform managed --project $(PROJECT_ID) --quiet

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
