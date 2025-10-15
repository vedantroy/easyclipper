#!/bin/bash

BRANCH=${1:-dev}
if [ "$BRANCH" != "dev" ] && [ "$BRANCH" != "main" ]; then
    echo "Error: Branch must be either 'dev' or 'main'"
    echo "Usage: $0 [dev|main]"
    exit 1
fi

# Load environment variables
source .env.build

# Check if required env vars are set
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ] || [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_PROJECT_NAME" ]; then
    echo "Error: Missing required environment variables. Please check .env.build"
    echo "Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_PROJECT_NAME"
    exit 1
fi

bun run build

# deploy
npx wrangler pages deploy dist \
    --project-name $CLOUDFLARE_PROJECT_NAME \
    --branch $BRANCH \
    --commit-dirty=true