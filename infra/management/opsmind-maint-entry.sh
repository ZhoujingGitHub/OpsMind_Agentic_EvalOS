#!/bin/sh
set -eu

exec sudo -n /usr/local/sbin/opsmind-evalos-maint "${SSH_ORIGINAL_COMMAND:-status}"
