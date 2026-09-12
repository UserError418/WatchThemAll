#!/usr/bin/env bash
#
# Build the Android debug APK.
#
#     scripts/build-apk.sh            # or: npm run apk
#
# ## Why this exists rather than a one-line npm script
#
# The npm script used to be `... && cd mobile/android && ./gradlew assembleDebug`,
# which builds correctly only if the shell already has `JAVA_HOME` pointing at a
# JDK 21. That is true in a terminal where `provision-android.sh` was sourced and
# false everywhere else — including a fresh session, a CI job, and any shell that
# has been restarted since. The failure is not obviously about Java:
#
#     Toolchain installation '/usr/lib/jvm/java-26-openjdk' does not provide
#     the required capabilities: [JAVA_COMPILER]
#
# Gradle picks up whatever JDK is default. On Arch that is currently 26, whose
# package ships no `javac`, so the message is about a missing compiler rather
# than about a version — and Android's Gradle plugin would refuse 26 anyway.
#
# So the JDK is resolved here, explicitly, and the build no longer depends on
# what the shell happens to remember.
set -euo pipefail

cd "$(dirname "$0")/.."

REQUIRED_MAJOR=21

# ── Find a JDK 21 ──────────────────────────────────────────────────────────
#
# In order of preference: one the caller has already chosen, the conventional
# Linux path, then whatever `/usr/lib/jvm` happens to hold. macOS gets
# `java_home`, which is the only reliable way to ask there.

java_major() {
  # `java -version` writes to stderr and its first line is e.g.
  #   openjdk version "21.0.12.1" 2026-08-18
  "$1/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/'
}

usable() {
  [[ -x "$1/bin/javac" ]] && [[ "$(java_major "$1")" == "$REQUIRED_MAJOR" ]]
}

resolve_jdk() {
  if [[ -n "${JAVA_HOME:-}" ]] && usable "$JAVA_HOME"; then
    echo "$JAVA_HOME"; return 0
  fi
  for candidate in /usr/lib/jvm/java-${REQUIRED_MAJOR}-openjdk /usr/lib/jvm/java-${REQUIRED_MAJOR}*; do
    [[ -d "$candidate" ]] && usable "$candidate" && { echo "$candidate"; return 0; }
  done
  if command -v /usr/libexec/java_home >/dev/null; then
    local mac
    mac=$(/usr/libexec/java_home -v "$REQUIRED_MAJOR" 2>/dev/null || true)
    [[ -n "$mac" ]] && usable "$mac" && { echo "$mac"; return 0; }
  fi
  return 1
}

if ! JDK=$(resolve_jdk); then
  cat >&2 <<EOF
error: no usable JDK $REQUIRED_MAJOR found.

Android's Gradle plugin needs exactly $REQUIRED_MAJOR; a newer default JDK fails
with a message about a missing JAVA_COMPILER rather than about its version.

  scripts/provision-android.sh     # installs it alongside your default

Or set JAVA_HOME to a JDK $REQUIRED_MAJOR yourself.
EOF
  exit 1
fi

export JAVA_HOME="$JDK"
echo "==> JDK $REQUIRED_MAJOR at $JAVA_HOME"

# ── Find the Android SDK ───────────────────────────────────────────────────
#
# Same story as the JDK, one layer down: Gradle reads `ANDROID_HOME`, or
# `sdk.dir` in an untracked `local.properties`, and a shell that has neither
# fails with "SDK location not found" rather than with anything about a missing
# provision step.
#
# `/opt/android-sdk` first because that is where `provision-android.sh` puts it.

resolve_sdk() {
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" /opt/android-sdk "$HOME/Android/Sdk"; do
    [[ -n "$candidate" && -d "$candidate/platforms" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}

if ! SDK=$(resolve_sdk); then
  cat >&2 <<EOF
error: no Android SDK found.

  scripts/provision-android.sh     # installs the command-line tools and platform

Or set ANDROID_HOME to an SDK that has a \`platforms/\` directory.
EOF
  exit 1
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
echo "==> Android SDK at $ANDROID_HOME"

npm run build:mobile
npm run sync:mobile

# `-p` rather than `cd`, so a failure leaves the caller where it found them.
./mobile/android/gradlew -p mobile/android assembleDebug

APK=mobile/android/app/build/outputs/apk/debug/app-debug.apk
[[ -f "$APK" ]] || { echo "error: gradle reported success but produced no APK" >&2; exit 1; }
echo "==> $APK ($(du -h "$APK" | cut -f1))"
