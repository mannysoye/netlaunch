#!/usr/bin/env bash
# Creates everything NetLaunch needs in AWS: a PRIVATE S3 bucket + a least-privilege IAM role (or user).
#
#   BUCKET=netlaunch-sites-yourname DOMAIN=netpins.xyz ./aws/setup.sh            # recommended: IAM role via OIDC
#   BUCKET=netlaunch-sites-yourname MODE=keys ./aws/setup.sh                      # fallback: IAM user + access key
#
# Prerequisites: AWS CLI v2 logged in as an admin (aws sts get-caller-identity works).
# For MODE=oidc the Worker must already be deployed on https://$DOMAIN, because AWS reads
# https://$DOMAIN/.well-known/openid-configuration when you create the provider.
set -euo pipefail

: "${BUCKET:?Set BUCKET to a globally-unique bucket name}"
MODE="${MODE:-oidc}"
REGION="${REGION:-us-east-1}"
ROLE_NAME="${ROLE_NAME:-netlaunch-worker}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Account: $ACCOUNT_ID  Region: $REGION  Bucket: $BUCKET  Mode: $MODE"

# ---------- 1. Bucket: private, encrypted, with a cleanup rule ----------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket exists, reusing it."
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi
# Nothing is ever public: the Worker reads objects with its own credentials and serves them itself.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules":[
    {"ID":"expire-abandoned-drafts","Status":"Enabled","Filter":{"Prefix":"drafts/"},"Expiration":{"Days":60}},
    {"ID":"expire-healthchecks","Status":"Enabled","Filter":{"Prefix":"healthcheck/"},"Expiration":{"Days":1}}
  ]}'
echo "✔ Bucket ready (private, encrypted, lifecycle rules set)"

# ---------- 2. Least-privilege permissions ----------
# s3:ListBucket is required so S3 answers 404 (not 403) for missing keys.
PERMISSIONS=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ObjectsRW", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$BUCKET/sites/*", "arn:aws:s3:::$BUCKET/drafts/*", "arn:aws:s3:::$BUCKET/healthcheck/*"] },
    { "Sid": "ListForCorrect404s", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::$BUCKET" }
  ]
}
JSON
)

if [ "$MODE" = "oidc" ]; then
  : "${DOMAIN:?Set DOMAIN (e.g. netpins.xyz) for MODE=oidc}"
  echo "Checking the Worker publishes its OIDC discovery document..."
  curl -fsS "https://$DOMAIN/.well-known/openid-configuration" >/dev/null \
    || { echo "✘ https://$DOMAIN/.well-known/openid-configuration is not reachable. Deploy the Worker with OIDC_PRIVATE_KEY set first (see README)."; exit 1; }

  PROVIDER_ARN="arn:aws:iam::$ACCOUNT_ID:oidc-provider/$DOMAIN"
  if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
    echo "OIDC provider exists, reusing it."
  else
    aws iam create-open-id-connect-provider --url "https://$DOMAIN" --client-id-list sts.amazonaws.com >/dev/null
  fi

  TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": { "$DOMAIN:aud": "sts.amazonaws.com", "$DOMAIN:sub": "netlaunch-worker" } }
  }]
}
JSON
)
  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
  else
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" --max-session-duration 3600 >/dev/null
  fi
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name netlaunch-s3 --policy-document "$PERMISSIONS"
  ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"
  echo
  echo "✔ Done. Put these in wrangler.jsonc → vars:"
  echo "    \"S3_BUCKET\": \"$BUCKET\","
  echo "    \"AWS_REGION\": \"$REGION\","
  echo "    \"AWS_ROLE_ARN\": \"$ROLE_ARN\""
  echo "Then redeploy and run the health check (see README)."
else
  USER_NAME="${USER_NAME:-netlaunch-worker-user}"
  aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || aws iam create-user --user-name "$USER_NAME" >/dev/null
  aws iam put-user-policy --user-name "$USER_NAME" --policy-name netlaunch-s3 --policy-document "$PERMISSIONS"
  echo "Creating an access key (shown ONCE). Store it with:  wrangler secret put AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY"
  aws iam create-access-key --user-name "$USER_NAME" --query 'AccessKey.{AWS_ACCESS_KEY_ID:AccessKeyId,AWS_SECRET_ACCESS_KEY:SecretAccessKey}' --output table
  echo "In wrangler.jsonc set S3_BUCKET=$BUCKET, AWS_REGION=$REGION and DELETE the AWS_ROLE_ARN line."
fi
