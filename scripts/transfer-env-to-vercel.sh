#!/bin/bash

# Transfer environment variables to Vercel
# Usage: ./scripts/transfer-env-to-vercel.sh

set -e

echo "🚀 Turtlebot Dashboard - Environment Variables Transfer"
echo "======================================================"
echo ""
echo "This script will help you set environment variables in Vercel."
echo ""

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI not found. Install it with:"
    echo "   npm install -g vercel"
    exit 1
fi

# Check if user is logged in to Vercel
if ! vercel whoami &> /dev/null; then
    echo "Please login to Vercel first:"
    vercel login
fi

echo "📋 Please provide your environment variables:"
echo ""

# Function to prompt for variable
prompt_var() {
    local var_name=$1
    local var_desc=$2
    read -p "Enter $var_desc ($var_name): " var_value
    if [ -n "$var_value" ]; then
        echo "Setting $var_name..."
        vercel env add $var_name production "$var_value"
    fi
}

# Prompt for each variable
prompt_var "VITE_SUPABASE_PROJECT_ID" "Supabase Project ID"
prompt_var "VITE_SUPABASE_URL" "Supabase URL (https://xxx.supabase.co)"
prompt_var "VITE_SUPABASE_PUBLISHABLE_KEY" "Supabase Anon/Publishable Key"
prompt_var "VITE_WALLETCONNECT_PROJECT_ID" "WalletConnect Project ID"

echo ""
echo "✅ Environment variables set successfully!"
echo ""
echo "To verify, run:"
echo "  vercel env list"
echo ""
echo "Then deploy with:"
echo "  vercel deploy --prod"
