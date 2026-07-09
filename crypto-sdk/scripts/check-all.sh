#!/usr/bin/env bash
# Run the full quality gate across all three Crypto SDK packages (Sprints 1–3).
# Typecheck + tests for each, plus lint/format from the SDK root (which nests them).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGES=("." "key-management" "crypto-engine")
NAMES=("crypto-sdk (Sprint 1)" "key-management (Sprint 2)" "crypto-engine (Sprint 3)")

echo "=== Lint + format (whole stack) ==="
npm run lint
npm run format:check

for i in "${!PACKAGES[@]}"; do
  pkg="${PACKAGES[$i]}"
  echo ""
  echo "=== ${NAMES[$i]} : typecheck + test + build ==="
  ( cd "$pkg" && npm run typecheck && npm run test && npm run build )
done

echo ""
echo "=== Runnable documented examples (against built output) ==="
node scripts/examples.mjs

echo ""
echo "✅ All packages passed: lint, format, typecheck, tests, build, examples."
