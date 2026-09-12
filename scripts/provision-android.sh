#!/usr/bin/env bash
#
# Install the Android build toolchain this box needs to produce an APK.
#
# Idempotent: every step checks before acting, so re-running it after a partial
# failure is safe and cheap.
#
# Two things here are not obvious and cost an afternoon each if you guess:
#
#  1. **The JDK version matters and the system default is wrong.** Arch ships
#     JDK 26 as `java`, and the Android Gradle Plugin supports 17 and 21 only —
#     it fails on a newer JDK with a class-file-version error that reads like a
#     corrupt dependency rather than a version mismatch. So JDK 21 is installed
#     alongside and pinned via JAVA_HOME rather than by switching the default,
#     which would affect every other tool on the machine.
#
#  2. **The SDK comes from Google's zip, not from a package.** Arch has no
#     `android-sdk` in the official repos; the AUR package needs `makepkg`,
#     which refuses to run as root, and this box runs its sessions as root.
#     Downloading the command-line tools directly sidesteps both and is what
#     Google's own CI images do.
#
set -euo pipefail

SDK_ROOT=/opt/android-sdk
# Pinned rather than "latest": a toolchain that silently changes under a build
# is a build that fails for reasons unrelated to the code.
CMDLINE_TOOLS_VERSION=11076708
# Must match `compileSdkVersion` in mobile/android/variables.gradle, which
# Capacitor generates and bumps with its own major versions. A mismatch fails
# late, in Gradle, as "Failed to install the following SDK components".
PLATFORM=android-36
BUILD_TOOLS=36.0.0

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "JDK 21 (the Android Gradle Plugin rejects the system's JDK 26)"
if [[ ! -d /usr/lib/jvm/java-21-openjdk ]]; then
  pacman -S --needed --noconfirm jdk21-openjdk
else
  echo "already present"
fi
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk

log "Android command-line tools"
if [[ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
  mkdir -p "$SDK_ROOT/cmdline-tools"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  # The zip unpacks to `cmdline-tools/`, but sdkmanager insists on living at
  # `cmdline-tools/latest/` — unpacked as-is it reports its own location as
  # invalid and refuses to run.
  mv "$tmp/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
else
  echo "already present"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$PATH"

log "SDK packages"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager --install \
  "platform-tools" \
  "platforms;${PLATFORM}" \
  "build-tools;${BUILD_TOOLS}" >/dev/null

log "Done"
cat <<EOF
Add to any shell that builds the app:

  export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
  export ANDROID_HOME=$SDK_ROOT
  export PATH="\$ANDROID_HOME/platform-tools:\$PATH"

Installed:
  java    $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)
  sdk     $PLATFORM, build-tools $BUILD_TOOLS
EOF
