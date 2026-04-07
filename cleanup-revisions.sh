#!/bin/bash

# Set your variables
SERVICE_NAME="timetable-api-node"
REGION="us-central1"

# 1. Get the name of the LATEST revision so we can exclude it explicitly
LATEST_REV=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.latestCreatedRevisionName)')

# 2. Get all revisions, exclude the latest one, and delete the rest
for revision in $(gcloud run revisions list \
    --service=$SERVICE_NAME \
    --region=$REGION \
    --format='value(metadata.name)' \
    --filter="metadata.name != $LATEST_REV"); do
        echo "Deleting old revision: $revision"
        gcloud run revisions delete $revision --region=$REGION --quiet
done
