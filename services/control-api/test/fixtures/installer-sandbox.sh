# Test-only command doubles. All filesystem paths are redirected by the test.
# Never invoke real services, package installation, network probes, or model calls.
record() { printf '%s\n' "$*" >> "$fixture/events"; }
fail_once() {
  if [[ "$failure" == "$1" && ! -f "$fixture/failure-injected" ]]; then
    touch "$fixture/failure-injected"
    return 37
  fi
}
readlink() { cat "$2"; }
ln() {
  local target="$2" destination="$3"
  if [[ "$destination" == *.rollback && "$recovery_failure" == pointer ]]; then return 71; fi
  printf '%s\n' "$target" > "$destination"
}
mv() {
  local destination
  for destination; do :; done
  if [[ "$destination" == */current && ! -f "$fixture/failure-injected" ]]; then
    fail_once switch || return $?
  fi
  command mv "$@"
}
cp() {
  local destination
  for destination; do :; done
  record "cp $*"
  if [[ "$destination" == */systemd/opsmind-evalos.service ]]; then
    fail_once config-backup || return $?
  fi
  if [[ "$destination" == */control/ && "$destination" == */backups/* ]]; then
    fail_once database-backup || return $?
  fi
  if [[ "$destination" == */etc/systemd/system/opsmind-evalos.service &&
        -f "$fixture/failure-injected" && "$recovery_failure" == config ]]; then return 72; fi
  command cp "$@"
}
tar() {
  local destination
  for destination; do :; done
  fail_once unpack || return $?
  command cp -R "$fixture/package/." "$destination/"
}
timeout() { record "dependencies"; fail_once dependencies; }
chown() { :; }
chmod() { :; }
systemctl() {
  record "systemctl $*"
  case "$1" in
    stop)
      printf 'stopped' > "$fixture/service-state"
      fail_once stop || return $?
      ;;
    start)
      local active
      active="$(cat "$fixture/opt/opsmind-evalos/current")"
      if [[ "$active" == *m31-20260903-1111111111 ]]; then
        # Simulate new records written after the deployment backup.
        printf '\nnew-record' >> "$fixture/var/lib/opsmind-evalos/control/control.sqlite"
        printf '\nnew-record' >> "$fixture/var/lib/opsmind-evalos/private/labels.sqlite"
        fail_once start || return $?
      elif [[ "$recovery_failure" == start ]]; then return 73; fi
      printf 'running' > "$fixture/service-state"
      ;;
    daemon-reload) fail_once reload || return $? ;;
  esac
}
install() {
  fail_once install || return $?
  record "install $*"
  command install "$@"
}
nginx() { record "nginx $*"; fail_once nginx; }
curl() { [[ "$failure" != readiness ]]; }
sleep() { :; }
journalctl() { record journalctl; }
node() { record smoke; fail_once smoke; }
du() { printf '128 control\n128 private\n'; }
df() {
  if [[ "$failure" == disk ]]; then
    printf 'Filesystem 1B-blocks Used Available Use Mounted\nfixture 100 99 1 99%% /\n'
  else
    printf 'Filesystem 1B-blocks Used Available Use Mounted\nfixture 9999999999 0 9999999999 0%% /\n'
  fi
}
