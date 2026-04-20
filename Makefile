SHELL := /bin/bash
NVM_USE := source ~/.nvm/nvm.sh && nvm use 22 --silent

.PHONY: start import import-slim test clear-short-cache clear-long-cache clear-all-cache cleanup-revisions

start:
	$(NVM_USE) && npm start

import:
	$(NVM_USE) && npm run import

import-slim:
	$(NVM_USE) && npm run import-slim

test:
	$(NVM_USE) && npm test

CF_CACHE_PURGE_URL := https://drop-cloudflare-cache-1041251696619.us-central1.run.app
SHORT_CACHE_TAGS ?= short-cache
LONG_CACHE_TAGS ?= long-cache

clear-short-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)?tags=$(SHORT_CACHE_TAGS)"

clear-long-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)?tags=$(LONG_CACHE_TAGS)"

clear-all-cache:
	curl -sS "$(CF_CACHE_PURGE_URL)"

cleanup-revisions:
	./cleanup-revisions.sh
