#!/bin/bash

ids=$(docker ps -q --filter name=^lp-worker-.*$)
if [ -z "$ids" ]; then
  echo "No containers to kill"
else
  echo "Killing containers: $ids"
  docker kill $ids
fi

ids=$(docker ps -q -a --filter name=^lp-worker-.*$)
if [ -z "$ids" ]; then
  echo "No containers to remove"
else
  echo "Removing containers: $ids"
  docker rm $ids
fi
