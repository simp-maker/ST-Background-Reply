#!/bin/sh
# Installs / updates the ST-Background-Reply server plugin. Run it again after reinstalling SillyTavern.
DIR="$(cd "$(dirname "$0")" && pwd)"
node "$DIR/installer/install.mjs" "$@"
