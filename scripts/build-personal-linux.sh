#!/usr/bin/env bash
set -euo pipefail

task_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_repo_root"

task_version="${1:-$(git describe --tags --abbrev=0 --match 'v*-nightly.*')}"
task_version="${task_version#v}"
task_output="${2:-$task_repo_root/release/personal}"

pnpm run build:desktop

# Official releases omit this fork's adapters, so personal builds have no update feed.
env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  pnpm exec node scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --build-version "$task_version" --output-dir "$task_output" --skip-build
