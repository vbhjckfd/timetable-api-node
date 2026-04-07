SHELL := /bin/bash
NVM_USE := source ~/.nvm/nvm.sh && nvm use 22 --silent

.PHONY: start import import-slim test clear-cache cleanup-revisions

start:
	$(NVM_USE) && npm start

import:
	$(NVM_USE) && npm run import

import-slim:
	$(NVM_USE) && npm run import-slim

test:
	$(NVM_USE) && npm test

clear-cache:
	curl -sS https://drop-cloudflare-cache-1041251696619.us-central1.run.app

cleanup-revisions:
	./cleanup-revisions.sh
