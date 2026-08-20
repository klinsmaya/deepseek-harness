#!/usr/bin/env bash
# vm-init.sh — initialize a Cursor Cloud Agent VM (systemd-less Ubuntu 24.04)
# with Tailscale (userspace networking) and 1Panel (with Docker).
#
# Idempotent: safe to run repeatedly. Requires a user with passwordless sudo.
#
# Configuration is read from the environment (all optional except TS_AUTHKEY,
# which is required to bring Tailscale online):
#
#   TS_AUTHKEY        Tailscale auth key (reusable, non-ephemeral recommended).
#   TS_HOSTNAME       Tailscale node name.            Default: cursor-cloud-agent
#   DOCKER_VERSION    Pinned Docker CE apt version.   Default: 5:28.5.2-1~ubuntu.24.04~noble
#   PANEL_PORT        1Panel port.                    Default: 8090
#   PANEL_ENTRANCE    1Panel security entrance path.  Default: 1panel
#   PANEL_USERNAME    1Panel admin username.          Default: admin
#   PANEL_PASSWORD    1Panel admin password.          Default: 1Panel@2026
#   PANEL_BASE_DIR    1Panel base directory.          Default: /opt
#   PANEL_LANGUAGE    1Panel UI language (en|zh|...). Default: zh
#   ONEPANEL_CHANNEL  1Panel release channel.         Default: stable
#   START_WATCHDOG    Launch a 60s self-heal loop.    Default: 1
#
# Usage:
#   sudo TS_AUTHKEY=tskey-... PANEL_PASSWORD='Str0ng@Pass' bash ops/vm-init.sh

set -uo pipefail

TS_HOSTNAME="${TS_HOSTNAME:-cursor-cloud-agent}"
DOCKER_VERSION="${DOCKER_VERSION:-5:28.5.2-1~ubuntu.24.04~noble}"
PANEL_PORT="${PANEL_PORT:-8090}"
PANEL_ENTRANCE="${PANEL_ENTRANCE:-1panel}"
PANEL_USERNAME="${PANEL_USERNAME:-admin}"
PANEL_PASSWORD="${PANEL_PASSWORD:-1Panel@2026}"
PANEL_BASE_DIR="${PANEL_BASE_DIR:-/opt}"
PANEL_LANGUAGE="${PANEL_LANGUAGE:-zh}"
ONEPANEL_CHANNEL="${ONEPANEL_CHANNEL:-stable}"
START_WATCHDOG="${START_WATCHDOG:-1}"
TS_AUTHKEY="${TS_AUTHKEY:-}"

log() { printf '\033[0;34m[vm-init %s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[0;33m[vm-init %s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '\033[0;31m[vm-init %s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

command -v sudo >/dev/null 2>&1 || die "sudo is required"

# ---------------------------------------------------------------------------
# Tailscale (userspace networking; default TUN mode does not work in these VMs)
# ---------------------------------------------------------------------------
install_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    log "tailscale already installed ($(tailscale version | head -1))"
  else
    log "installing tailscale"
    curl -fsSL https://tailscale.com/install.sh | sudo sh || die "tailscale install failed"
  fi
  # This VM has no systemd; never rely on the packaged tailscaled.service.
  sudo systemctl disable --now tailscaled >/dev/null 2>&1 || true
}

start_tailscaled() {
  if pgrep -x tailscaled >/dev/null 2>&1; then
    log "tailscaled already running"
    return 0
  fi
  log "starting tailscaled in userspace networking mode"
  sudo tailscaled \
    --tun=userspace-networking \
    --outbound-http-proxy-listen=localhost:1054 \
    --socks5-server=localhost:1055 \
    >/tmp/tailscaled.log 2>&1 &
  for _ in $(seq 1 10); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done
}

up_tailscale() {
  local state
  state="$(sudo tailscale status --json 2>/dev/null | tr -d ' ' \
    | grep -o '"BackendState":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ "$state" = "Running" ]; then
    log "tailscale already connected: $(sudo tailscale ip -4 2>/dev/null | head -1)"
    return 0
  fi
  if [ -z "$TS_AUTHKEY" ]; then
    warn "TS_AUTHKEY not set; tailscale installed but NOT logged in (BackendState=$state)"
    warn "re-run with TS_AUTHKEY=... or run: sudo tailscale up --hostname=$TS_HOSTNAME"
    return 0
  fi
  log "bringing tailscale up with auth key"
  sudo tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" \
    || die "tailscale up failed (check the auth key)"
  log "tailscale connected: $(sudo tailscale ip -4 2>/dev/null | head -1)"
}

# ---------------------------------------------------------------------------
# Docker (fuse-overlayfs storage driver + iptables-legacy, manual dockerd)
# ---------------------------------------------------------------------------
install_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "installing Docker CE $DOCKER_VERSION"
    sudo install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
      curl --retry 3 --retry-delay 5 -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      sudo chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      "docker-ce=$DOCKER_VERSION" "docker-ce-cli=$DOCKER_VERSION" \
      containerd.io docker-buildx-plugin docker-compose-plugin \
      -o Dpkg::Options::=--force-confold || die "docker install failed"
  else
    log "docker already installed ($(docker --version))"
  fi

  # fuse-overlayfs is required: the kernel lacks full overlay2 support.
  if ! command -v fuse-overlayfs >/dev/null 2>&1; then
    log "installing fuse-overlayfs"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      fuse-overlayfs -o Dpkg::Options::=--force-confold \
      || sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a --force-confold
  fi

  # docker-compose v1-style shim for tools/scripts that call `docker-compose`.
  if ! command -v docker-compose >/dev/null 2>&1; then
    sudo curl -sL "https://resource.fit2cloud.com/docker/compose/releases/download/v2.26.1/docker-compose-linux-x86_64" \
      -o /usr/local/bin/docker-compose && sudo chmod +x /usr/local/bin/docker-compose \
      && sudo ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
  fi

  sudo mkdir -p /etc/docker
  if ! grep -q fuse-overlayfs /etc/docker/daemon.json 2>/dev/null; then
    log "writing /etc/docker/daemon.json (storage-driver=fuse-overlayfs)"
    printf '%s\n' '{' '  "storage-driver": "fuse-overlayfs"' '}' \
      | sudo tee /etc/docker/daemon.json >/dev/null
  fi

  # iptables-nft is not fully supported by the kernel; use the legacy backend.
  sudo update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
  sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
}

start_dockerd() {
  if sudo docker version >/dev/null 2>&1; then
    log "docker daemon already running"
    return 0
  fi
  if ! pgrep -x dockerd >/dev/null 2>&1; then
    log "starting dockerd"
    sudo dockerd >/tmp/dockerd.log 2>&1 &
  fi
  for _ in $(seq 1 20); do
    sudo docker version >/dev/null 2>&1 && break
    sleep 1
  done
  sudo docker version >/dev/null 2>&1 || die "dockerd did not become ready (see /tmp/dockerd.log)"
  log "docker daemon ready ($(sudo docker version --format '{{.Server.Version}}'))"
}

# ---------------------------------------------------------------------------
# 1Panel (no systemd: configure via 1pctl ORIGINAL_* and run the binary directly)
# ---------------------------------------------------------------------------
install_1panel() {
  if command -v 1panel >/dev/null 2>&1; then
    log "1panel already installed ($(1pctl version 2>/dev/null | head -1))"
    return 0
  fi
  local arch version pkg workdir
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture for 1Panel: $(uname -m)" ;;
  esac
  version="$(curl -s "https://resource.fit2cloud.com/1panel/package/${ONEPANEL_CHANNEL}/latest")"
  [ -n "$version" ] || die "could not resolve latest 1Panel version"
  pkg="1panel-${version}-linux-${arch}.tar.gz"
  workdir="$(mktemp -d)"
  log "downloading 1Panel ${version}"
  curl -sLk "https://resource.fit2cloud.com/1panel/package/${ONEPANEL_CHANNEL}/${version}/release/${pkg}" \
    -o "${workdir}/${pkg}" || die "1Panel download failed"
  tar -xzf "${workdir}/${pkg}" -C "${workdir}" || die "1Panel extract failed"
  local src="${workdir}/1panel-${version}-linux-${arch}"

  log "deploying 1Panel binaries and configuration"
  sudo cp "${src}/1panel" /usr/local/bin/ && sudo chmod +x /usr/local/bin/1panel
  sudo ln -sf /usr/local/bin/1panel /usr/bin/1panel
  sudo cp "${src}/1pctl" /usr/local/bin/ && sudo chmod +x /usr/local/bin/1pctl
  sudo ln -sf /usr/local/bin/1pctl /usr/bin/1pctl

  sudo sed -i -e "s#BASE_DIR=.*#BASE_DIR=${PANEL_BASE_DIR}#g" /usr/local/bin/1pctl
  sudo sed -i -e "s#ORIGINAL_PORT=.*#ORIGINAL_PORT=${PANEL_PORT}#g" /usr/local/bin/1pctl
  sudo sed -i -e "s#ORIGINAL_USERNAME=.*#ORIGINAL_USERNAME=${PANEL_USERNAME}#g" /usr/local/bin/1pctl
  local escaped_password
  escaped_password="$(printf '%s' "$PANEL_PASSWORD" | sed 's/[!@#$%*_,.?]/\\&/g')"
  sudo sed -i -e "s#ORIGINAL_PASSWORD=.*#ORIGINAL_PASSWORD=${escaped_password}#g" /usr/local/bin/1pctl
  sudo sed -i -e "s#ORIGINAL_ENTRANCE=.*#ORIGINAL_ENTRANCE=${PANEL_ENTRANCE}#g" /usr/local/bin/1pctl
  sudo sed -i -e "s#LANGUAGE=.*#LANGUAGE=${PANEL_LANGUAGE}#g" /usr/local/bin/1pctl

  sudo mkdir -p "${PANEL_BASE_DIR}/1panel/geo"
  [ -f "${src}/GeoIP.mmdb" ] && sudo cp "${src}/GeoIP.mmdb" "${PANEL_BASE_DIR}/1panel/geo/"
  sudo cp -r "${src}/lang" /usr/local/bin/
  sudo cp -rf "${src}/initscript" "${PANEL_BASE_DIR}/1panel/"
  rm -rf "$workdir"
}

start_1panel() {
  if pgrep -f '/usr/bin/1panel$' >/dev/null 2>&1; then
    log "1panel already running"
  else
    log "starting 1panel service"
    sudo /usr/bin/1panel >>/tmp/1panel.log 2>&1 &
  fi
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}" && break
    sleep 1
  done
  curl -sf -o /dev/null "http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}" \
    || die "1panel did not become healthy (see /tmp/1panel.log)"
  log "1panel healthy at http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}"
}

# ---------------------------------------------------------------------------
# Self-heal watchdog: keep dockerd, tailscaled+login, and 1panel alive.
# ---------------------------------------------------------------------------
install_watchdog() {
  log "installing self-heal script /usr/local/bin/vm-services-ensure.sh"
  sudo tee /usr/local/bin/vm-services-ensure.sh >/dev/null <<ENSURE
#!/usr/bin/env bash
# Auto-generated by vm-init.sh. Keeps Docker, Tailscale, and 1Panel alive.
set -u
LOG=/tmp/vm-services-ensure.log
log() { printf '%s %s\n' "\$(date -Is)" "\$*" >> "\$LOG"; }

# Docker
if ! sudo docker version >/dev/null 2>&1; then
  pgrep -x dockerd >/dev/null 2>&1 || { log "starting dockerd"; sudo dockerd >>/tmp/dockerd.log 2>&1 & }
  for _ in \$(seq 1 20); do sudo docker version >/dev/null 2>&1 && break; sleep 1; done
fi

# Tailscale daemon + login
if ! pgrep -x tailscaled >/dev/null 2>&1; then
  log "starting tailscaled"
  sudo tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1054 --socks5-server=localhost:1055 >>/tmp/tailscaled.log 2>&1 &
  for _ in \$(seq 1 10); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 1; done
fi
state="\$(sudo tailscale status --json 2>/dev/null | tr -d ' ' | grep -o '"BackendState":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ "\$state" != "Running" ]; then
  key="\${TS_AUTHKEY:-}"
  [ -z "\$key" ] && [ -r "\$HOME/.config/tailscale/authkey" ] && key="\$(cat "\$HOME/.config/tailscale/authkey")"
  if [ -n "\$key" ]; then log "tailscale up (state=\$state)"; sudo tailscale up --authkey="\$key" --hostname="${TS_HOSTNAME}" >>\$LOG 2>&1; fi
fi

# 1Panel
if ! pgrep -f '/usr/bin/1panel\$' >/dev/null 2>&1; then
  log "starting 1panel"
  sudo /usr/bin/1panel >>/tmp/1panel.log 2>&1 &
  for _ in \$(seq 1 15); do curl -sf -o /dev/null "http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}" && break; sleep 1; done
fi
ENSURE
  sudo chmod +x /usr/local/bin/vm-services-ensure.sh

  # Persist the auth key so the watchdog can re-login after a drop.
  if [ -n "$TS_AUTHKEY" ]; then
    install -m 700 -d "$HOME/.config/tailscale"
    (umask 177; printf '%s' "$TS_AUTHKEY" > "$HOME/.config/tailscale/authkey")
    chmod 600 "$HOME/.config/tailscale/authkey"
  fi

  if [ "$START_WATCHDOG" = "1" ]; then
    if pgrep -f 'vm-services-ensure.sh' >/dev/null 2>&1; then
      log "watchdog already running"
    else
      log "starting 60s self-heal watchdog"
      sudo setsid bash -c 'while true; do /usr/local/bin/vm-services-ensure.sh; sleep 60; done' \
        >/tmp/vm-services-watchdog.log 2>&1 &
    fi
  fi
}

# ---------------------------------------------------------------------------
verify() {
  log "==== verification ===="
  sudo tailscale status 2>/dev/null | grep -i "$TS_HOSTNAME" || warn "tailscale not connected"
  sudo docker version --format 'docker server {{.Server.Version}}' 2>/dev/null || warn "docker not ready"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}" 2>/dev/null)"
  log "1panel http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE} -> HTTP ${code}"
  log "1panel user: ${PANEL_USERNAME} (password set via PANEL_PASSWORD)"
}

main() {
  log "starting VM initialization (tailscale + docker + 1panel)"
  install_tailscale
  start_tailscaled
  up_tailscale
  install_docker
  start_dockerd
  install_1panel
  start_1panel
  install_watchdog
  verify
  log "done. 1Panel: http://127.0.0.1:${PANEL_PORT}/${PANEL_ENTRANCE}"
}

main "$@"
