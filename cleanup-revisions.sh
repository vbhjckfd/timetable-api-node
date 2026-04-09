#!/bin/bash

# Set your variables
SERVICE_NAME="timetable-api-node"
REGION="us-central1"
PROJECT_ID="timetable-252615"
GCR_IMAGE="us.gcr.io/$PROJECT_ID/github_vbhjckfd_timetable-api-node/$SERVICE_NAME"

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

# 4. Delete untagged (old) image digests from GCR
echo "Cleaning up untagged images in $GCR_IMAGE..."
for digest in $(gcloud container images list-tags "$GCR_IMAGE" \
    --format='json' \
    --limit=unlimited \
    | python3 -c "import json,sys; [print(i['digest']) for i in json.load(sys.stdin) if not i.get('tags')]"); do
        echo "Deleting untagged digest: $digest"
        gcloud container images delete "$GCR_IMAGE@$digest" --force-delete-tags --quiet
done
