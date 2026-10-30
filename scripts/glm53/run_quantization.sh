#!/usr/bin/env bash
# Quantize GLM-5.3-Flash experts to W4A16, then upload the result to S3.
# Usage: fill in the three paths, then
#   nohup ./run_quantization.sh > run_quantization.log 2>&1 &
set -e

SRC=/path/to/GLM-5.3-Flash
DST=/path/to/GLM-5.3-Flash-W4A16
S3=s3://your-bucket/GLM-5.3-Flash-W4A16

python -u "$(dirname "$0")/quantize_glm53_experts_w4a16.py" --src "$SRC" --dst "$DST" --gpus 0,1,2,3,4,5,6,7
aws s3 sync "$DST" "$S3"
echo "ALL DONE"
