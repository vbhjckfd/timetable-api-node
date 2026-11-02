#!/bin/bash

# Set your variables
SERVICE_NAME="timetable-api-node"
REGION="europe-north1"

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

# 3. Cancel old queued/running Cloud Builds
for build_id in $(gcloud builds list \
    --format='value(id)' \
    --filter='status=QUEUED OR status=WORKING'); do
        echo "Cancelling old build: $build_id"
        gcloud builds cancel $build_id --quiet
done

# Old images need no cleanup here: the Artifact Registry repo's cleanup policy
# deletes versions older than 14 days, keeping the 5 most recent.
