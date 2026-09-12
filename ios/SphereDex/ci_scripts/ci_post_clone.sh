#!/bin/sh

# Xcode Cloud post-clone step.
#
# This repo tracks project.yml as the XcodeGen source of truth and does NOT rely on a hand-maintained
# .xcodeproj. Xcode Cloud runs this script right after cloning the repo and before it resolves
# dependencies / builds, so we regenerate SphereDex.xcodeproj from project.yml here. That guarantees
# the cloud build matches project.yml exactly - same targets, same shared scheme, same version
# (MARKETING_VERSION / CURRENT_PROJECT_VERSION live in project.yml).
#
# Homebrew is preinstalled on Xcode Cloud's macOS images, so `brew install` is available. The app has
# no SPM / CocoaPods dependencies, so XcodeGen is all we need.

set -e

echo "==> Installing XcodeGen"
which xcodegen >/dev/null 2>&1 || brew install xcodegen

echo "==> Generating SphereDex.xcodeproj from project.yml"
cd "$CI_PRIMARY_REPOSITORY_PATH/ios/SphereDex"
xcodegen generate

echo "==> Done: $(xcodegen --version)"
