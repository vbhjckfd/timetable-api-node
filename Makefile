SHELL := /bin/bash
NVM_USE := source ~/.nvm/nvm.sh && nvm use 22 --silent

.PHONY: start import import-slim test

start:
	$(NVM_USE) && npm start

import:
	$(NVM_USE) && npm run import

import-slim:
	$(NVM_USE) && npm run import-slim

test:
	$(NVM_USE) && npm test
