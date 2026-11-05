# Turtlebot Dashboard - Vercel Deployment Guide

## Quick Start

### 1. Connect to Vercel

```bash
# Install Vercel CLI (if not already installed)
npm install -g vercel

# Login to Vercel
vercel login

# Deploy from this directory
vercel --prod
```

### 2. Environment Variables

Add these secrets to your Vercel project (Settings → Environment Variables):

```
VITE_SUPABASE_PROJECT_ID=your-project-ref
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
VITE_WALLETCONNECT_PROJECT_ID=your-walletconnect-project-id
```

Get these values from:
- **Supabase**: Settings → API → Project URL & Publishable Key
- **WalletConnect**: Dashboard → Create Project → Project ID

### 3. GitHub Integration (Automatic Deployments)

1. Go to https://vercel.com
2. Import the repository: `harrisoma/turtle-bot-dashboard`
3. Set the same environment variables above
4. Enable automatic deployments from `main` branch

Every push to `main` will automatically deploy to production.

### 4. GitHub Actions Secrets (For CI/CD)

Add these to your GitHub repository (Settings → Secrets and variables → Actions):

```
VERCEL_TOKEN: Your Vercel API Token
VERCEL_ORG_ID: Your Vercel Organization ID
VERCEL_PROJECT_ID: Your Vercel Project ID
```

Get these from:
- **VERCEL_TOKEN**: https://vercel.com/account/tokens
- **VERCEL_ORG_ID**: https://vercel.com/account
- **VERCEL_PROJECT_ID**: Project Settings on Vercel dashboard

## Build & Test Locally

```bash
# Install dependencies
npm install

# Build locally
npm run build

# Preview build
npm run preview
```

## Deployment Status

- ✅ Frontend: Ready for Vercel
- ✅ Build Config: vercel.json configured
- ✅ Environment: Variables template in place
- ✅ CI/CD: GitHub Actions workflow configured
- ⏳ Deployment: Awaiting Vercel setup

## Production URLs

Once deployed, your app will be available at:
- Production: `turtle-bot-dashboard.vercel.app` (or custom domain)
- Automatic preview URLs for pull requests

## Troubleshooting

### Build Fails
- Check that all env vars are set correctly
- Ensure Node.js 20+ is selected in Vercel settings
- Check build logs on Vercel dashboard

### Supabase Connection Issues
- Verify VITE_SUPABASE_URL is correct
- Check that VITE_SUPABASE_PUBLISHABLE_KEY is the anon/public key (not service role)
- Ensure Supabase project is running

### WalletConnect Not Working
- Verify VITE_WALLETCONNECT_PROJECT_ID is set
- Check WalletConnect dashboard for project settings
