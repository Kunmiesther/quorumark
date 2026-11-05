# Environment Variables Transfer Guide

## Overview

This guide helps you transfer environment variables from your local setup to Vercel for the Turtlebot Dashboard.

## Required Variables

All Vercel deployments need these 4 variables:

| Variable | Source | Example |
|----------|--------|---------|
| `VITE_SUPABASE_PROJECT_ID` | Supabase Settings | `abc123def456` |
| `VITE_SUPABASE_URL` | Supabase API Settings | `https://abc123def456.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase API → Anon Key | `sb_publishable_xxx` |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect Dashboard | `your-project-id` |

## Method 1: Using the Transfer Script (Easiest)

### Step 1: Extract Variables from Local .env
```bash
python3 scripts/extract-env.py
```

This will:
- Read from your local `.env` file
- Extract the Vercel-needed variables
- Create `.env.vercel.json` backup

### Step 2: Set in Vercel
```bash
# Make sure you're logged in
vercel login

# Run interactive script
chmod +x scripts/transfer-env-to-vercel.sh
./scripts/transfer-env-to-vercel.sh
```

The script will prompt you to enter each variable and set it in Vercel.

### Step 3: Verify
```bash
vercel env list
```

Should show all 4 variables set to `production`.

## Method 2: Manual Setup in Vercel Dashboard

1. Go to https://vercel.com/dashboard
2. Select your Turtlebot Dashboard project
3. Settings → Environment Variables
4. Add each variable:
   - Name: `VITE_SUPABASE_PROJECT_ID`
   - Value: Your Supabase project ID
   - Environments: Check `Production`
   - Click "Save"
5. Repeat for all 4 variables

## Method 3: Vercel CLI Direct

```bash
vercel login

# Set production environment variables
vercel env add VITE_SUPABASE_PROJECT_ID production
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
vercel env add VITE_WALLETCONNECT_PROJECT_ID production

# List to verify
vercel env list
```

## How to Get Your Values

### From Supabase
1. Go to https://app.supabase.com
2. Select your Turtlebot project
3. Settings → API
4. Copy:
   - **Project URL** → `VITE_SUPABASE_URL`
   - **Project Reference** (in URL) → `VITE_SUPABASE_PROJECT_ID`
   - **Anon (public) Key** → `VITE_SUPABASE_PUBLISHABLE_KEY`

### From WalletConnect
1. Go to https://cloud.walletconnect.com
2. Create or select your project
3. Copy:
   - **Project ID** → `VITE_WALLETCONNECT_PROJECT_ID`

## Deployment After Setting Variables

Once variables are set:

```bash
# Option 1: Deploy immediately
vercel deploy --prod

# Option 2: Push to GitHub (auto-deploys via Actions)
git push origin main
```

## Troubleshooting

### Variables not showing in Vercel UI
- They might be set for Preview/Development instead of Production
- Check the "Environments" filter in Vercel dashboard

### Build fails with "VITE_SUPABASE_URL is undefined"
- Verify all 4 variables are set
- Check spelling (case-sensitive)
- Ensure they're in "Production" environment

### Can't run the transfer script
```bash
# Make it executable
chmod +x scripts/transfer-env-to-vercel.sh

# Run with bash explicitly
bash scripts/transfer-env-to-vercel.sh
```

## Security Notes

⚠️ **Important:**
- Never commit `.env` files with real secrets
- `.env.vercel.json` is created by the script - add to `.gitignore` if not already there
- Only share variable values through secure channels
- Rotate secrets periodically

## Verify Deployment

After deployment:

```bash
# Check live URL
vercel --list

# View logs
vercel logs <deployment-url>

# Test connection
curl https://your-turtle-bot-dashboard.vercel.app/health
```

## Support

If variables are still not working after transfer:

1. Check GitHub Actions logs: `.github/workflows/deploy-vercel.yml`
2. Check Vercel deployment logs: https://vercel.com/dashboard
3. Verify Supabase project is running
4. Test locally: `npm run dev` with the same env vars
