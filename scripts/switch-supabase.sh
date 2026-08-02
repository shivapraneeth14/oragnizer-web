#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-}"
if [[ "$ENV_NAME" != "test" && "$ENV_NAME" != "prod" ]]; then
  echo "Usage: ./scripts/switch-supabase.sh <test|prod>" >&2
  exit 1
fi

if [[ "$ENV_NAME" == "test" ]]; then
  URL="https://ofvfasdgdwkehdcjugnf.supabase.co"
  ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mdmZhc2RnZHdrZWhkY2p1Z25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1OTkxNDcsImV4cCI6MjEwMTE3NTE0N30.oaxiWOFClGzO1WqBihmLoZV69soVpfMv6gtUMnMakxY"
else
  URL="https://vdxspyumkvwawmqwfkzr.supabase.co"
  ANON="sb_publishable_phag39UwA63y44O1703IkA_Ky6ebjwV"
fi

cat > apps/organizer-web/.env <<EOF
VITE_SUPABASE_URL=$URL
VITE_SUPABASE_ANON_KEY=$ANON

# Cloudinary
VITE_CLOUDINARY_CLOUD_NAME=djz0pypu1
VITE_CLOUDINARY_UPLOAD_PRESET=cluvo_preset
VITE_APP_DEEPLINK_BASE=cluvo://
VITE_APP_URL=https://cluvo-nu.vercel.app
EOF

cat > apps/admin-web/.env <<EOF
VITE_SUPABASE_URL=$URL
VITE_SUPABASE_ANON_KEY=$ANON
EOF

echo "organizer-web + admin-web -> $URL ($ENV_NAME)"
echo
echo "Flutter local run:"
echo "  flutter run -d chrome --dart-define=SUPABASE_URL=$URL --dart-define=SUPABASE_ANON_KEY=$ANON"
