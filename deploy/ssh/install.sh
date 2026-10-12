#!/bin/sh
# Serve ForgeHub's git over the host's standard SSH port 22, keeping sshd for
# administration. Run as root on the host that runs ForgeHub. Idempotent.
#
#   sudo ./install.sh [listen-port]      listen-port: where ForgeHub's built-in SSH
#                                        server listens on loopback (default 2222)
#
# Afterwards set, for the ForgeHub container (see the end of this script's output):
#   FORGEHUB_SSH_PORT, FORGEHUB_SSH_PUBLIC_PORT=22, FORGEHUB_SSH_FORWARD_KEY
# and publish the SSH port on 127.0.0.1 only (FORGEHUB_SSH_BIND=127.0.0.1).
set -eu

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
port=${1:-2222}
case $port in ''|*[!0-9]*) echo "listen-port must be a number" >&2; exit 1 ;; esac

# Tools the scripts need. Install rather than ask the admin to.
need=""
command -v ssh >/dev/null 2>&1 || need="$need openssh-client"
command -v ssh-keygen >/dev/null 2>&1 || need="$need openssh-client"
command -v base64 >/dev/null 2>&1 || need="$need coreutils"
if [ -n "$need" ]; then
  if command -v apt-get >/dev/null 2>&1; then apt-get install -y $need
  elif command -v dnf >/dev/null 2>&1; then dnf install -y openssh-clients coreutils
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed openssh coreutils
  elif command -v zypper >/dev/null 2>&1; then zypper install -y openssh-clients coreutils
  else echo "install an OpenSSH client and coreutils, then rerun" >&2; exit 1; fi
fi

# The account git clients connect as. Locked password (sshd refuses '!' accounts)
# and a real shell (sshd runs the forced command through it).
if ! id git >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/forgehub-git --shell /bin/sh git
fi
usermod -p '*' git

install -d -m 0750 -o root -g git /etc/forgehub
if [ ! -f /etc/forgehub/forward_key ]; then
  ssh-keygen -q -t ed25519 -N '' -C forgehub-forward -f /etc/forgehub/forward_key
fi
chown root:git /etc/forgehub/forward_key /etc/forgehub/forward_key.pub
chmod 0640 /etc/forgehub/forward_key
chmod 0644 /etc/forgehub/forward_key.pub
touch /etc/forgehub/known_hosts
chown git:git /etc/forgehub/known_hosts
chmod 0644 /etc/forgehub/known_hosts

cat > /etc/forgehub/ssh.conf <<CONF
FORGEHUB_SSH_LISTEN_PORT=$port
FORGEHUB_FORWARD_KEY=/etc/forgehub/forward_key
FORGEHUB_KNOWN_HOSTS=/etc/forgehub/known_hosts
CONF
chmod 0644 /etc/forgehub/ssh.conf

install -m 0755 -o root -g root "$here/forgehub-authorized-keys" /usr/local/sbin/forgehub-authorized-keys
install -m 0755 -o root -g root "$here/forgehub-shell" /usr/local/sbin/forgehub-shell

# sshd must read drop-ins; older configs have no Include line.
main=/etc/ssh/sshd_config
if ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' "$main"; then
  # Include must come before the first Match block or it would sit inside it.
  cp "$main" "$main.forgehub-backup"
  { echo 'Include /etc/ssh/sshd_config.d/*.conf'; cat "$main.forgehub-backup"; } > "$main"
fi
install -d -m 0755 /etc/ssh/sshd_config.d
install -m 0644 "$here/sshd_config.forgehub" /etc/ssh/sshd_config.d/forgehub.conf

# Never reload sshd into a broken config: that would lock the admin out.
if ! sshd -t; then
  rm -f /etc/ssh/sshd_config.d/forgehub.conf
  [ ! -f "$main.forgehub-backup" ] || cp "$main.forgehub-backup" "$main"
  echo "sshd rejected the config; reverted. Nothing was reloaded." >&2
  exit 1
fi
# The config is valid; apply it. A failed reload (no init system, unusual unit
# name) is reported, not fatal: the drop-in is in place and takes effect on the
# next sshd restart.
reloaded=0
for unit in sshd ssh; do
  if command -v systemctl >/dev/null 2>&1 && systemctl reload "$unit" 2>/dev/null; then reloaded=1; break; fi
  if command -v service >/dev/null 2>&1 && service "$unit" reload >/dev/null 2>&1; then reloaded=1; break; fi
done
if [ "$reloaded" -ne 1 ]; then
  echo "Could not reload sshd automatically. The config is valid and installed;" >&2
  echo "reload or restart sshd yourself (e.g. systemctl reload sshd) to apply it." >&2
fi

cat <<OUT

Host side is ready. Now configure ForgeHub (e.g. in .env):

  FORGEHUB_SSH_PORT=$port
  FORGEHUB_SSH_PUBLIC_PORT=22
  FORGEHUB_SSH_BIND=127.0.0.1
  FORGEHUB_SSH_FORWARD_KEY="$(cat /etc/forgehub/forward_key.pub)"

then restart ForgeHub. Test from another machine:

  git clone git@<this-host>:<owner>/<repo>.git
OUT
