#!/usr/bin/env bash
# Emails you before AWS can surprise you. AWS has NO hard spending cap; this is an alarm, not a brake.
#   EMAIL=you@example.com ./aws/budget.sh
set -euo pipefail
: "${EMAIL:?Set EMAIL}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"netlaunch-guard","BudgetLimit":{"Amount":"1","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers "[
    {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":10,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},
    {\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}
  ]"
echo "✔ Budget alarm created: you'll be emailed at \$0.10 actual spend and if the forecast passes \$1."
