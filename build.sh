#gcloud builds submit --tag gcr.io/timetable-252615/timetable-api-node-sqlite

docker build --build-arg CACHEBUST=$(date +%s) -t gcr.io/timetable-252615/timetable-api-node-sqlite .
docker push gcr.io/timetable-252615/timetable-api-node-sqlite