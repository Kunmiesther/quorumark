#!/usr/bin/env python3
"""
Extract environment variables for Vercel transfer
Usage: python3 scripts/extract-env.py
"""

import os
import json
from pathlib import Path

def extract_env_vars(env_file=".env"):
    """Extract Vercel-needed variables from .env file"""

    vars_needed = [
        "VITE_SUPABASE_PROJECT_ID",
        "VITE_SUPABASE_URL",
        "VITE_SUPABASE_PUBLISHABLE_KEY",
        "VITE_WALLETCONNECT_PROJECT_ID",
    ]

    env_vars = {}

    # Try to read from .env file
    if os.path.exists(env_file):
        print(f"📖 Reading from {env_file}...\n")
        with open(env_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    key, _, value = line.partition('=')
                    if key in vars_needed:
                        env_vars[key] = value.strip('"\'')

    # Also check system environment
    for var in vars_needed:
        if var not in env_vars and var in os.environ:
            env_vars[var] = os.environ[var]

    # Display results
    print("📊 Environment Variables for Vercel")
    print("=" * 50)
    print()

    for var in vars_needed:
        if var in env_vars:
            value = env_vars[var]
            masked = f"{value[:20]}..." if len(value) > 20 else value
            print(f"✅ {var}")
            print(f"   Value: {masked}")
        else:
            print(f"❌ {var}")
            print(f"   Not found - You'll need to set this manually")
        print()

    # Export as JSON for import
    with open('.env.vercel.json', 'w') as f:
        json.dump(env_vars, f, indent=2)

    print("📁 Variables exported to: .env.vercel.json")
    print()
    print("Next steps:")
    print("1. Run: vercel login")
    print("2. Run: ./scripts/transfer-env-to-vercel.sh")
    print("3. Or manually set in Vercel dashboard → Settings → Environment Variables")

if __name__ == "__main__":
    extract_env_vars()
