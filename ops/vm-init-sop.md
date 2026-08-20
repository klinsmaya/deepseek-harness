# SOP：系统初始化安装 Tailscale 与 1Panel

本 SOP 用于在 **Cursor Cloud Agent VM**（无 systemd 的容器化 Ubuntu 24.04）上初始化安装 Tailscale（userspace networking）与 1Panel（含 Docker）。全部步骤幂等，可重复执行。自动化脚本见 [vm-init.sh](vm-init.sh)。

## 1. 适用环境与前置条件

- 系统：Ubuntu 24.04（x86_64/amd64；arm64 亦支持），容器化、**无 systemd**（`/run/systemd/system` 不存在）。
- 权限：具备免密 `sudo` 的用户。
- 网络：可访问 `tailscale.com`、`download.docker.com`、`resource.fit2cloud.com`。
- 关键约束（务必遵守）：
  - Tailscale 必须用 **userspace networking** 模式（默认 TUN 模式在此类 VM 无法工作）。
  - Docker 必须用 **fuse-overlayfs** 存储驱动 + **iptables-legacy**，并手动启动 `dockerd`（内核不完整支持 overlay2/nftables）。
  - 无 systemd，所有守护进程（`tailscaled`/`dockerd`/`1panel`）以后台进程方式手动启动，不能依赖 `systemctl`。
  - 切勿设置 `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE`（与本 SOP 无关，但同一 VM 上会劫持 Cursor 的 git hooks）。

## 2. 参数与密钥

自动化脚本从环境变量读取配置（除 `TS_AUTHKEY` 外均有默认值）：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TS_AUTHKEY` | Tailscale auth key（建议 Reusable、非 Ephemeral、较长有效期） | 无（缺省则只安装不登录） |
| `TS_HOSTNAME` | Tailscale 节点名 | `cursor-cloud-agent` |
| `DOCKER_VERSION` | 固定的 Docker CE apt 版本 | `5:28.5.2-1~ubuntu.24.04~noble` |
| `PANEL_PORT` | 1Panel 端口 | `8090` |
| `PANEL_ENTRANCE` | 1Panel 安全入口路径 | `1panel` |
| `PANEL_USERNAME` | 1Panel 管理员用户名 | `admin` |
| `PANEL_PASSWORD` | 1Panel 管理员密码（`^[a-zA-Z0-9_!@#$%*,.?]{8,30}$`） | `1Panel@2026` |
| `PANEL_BASE_DIR` | 1Panel 基础目录 | `/opt` |
| `PANEL_LANGUAGE` | 面板语言（`en`/`zh` 等） | `zh` |
| `START_WATCHDOG` | 是否启动 60s 自愈看护循环 | `1` |

`TS_AUTHKEY` 属敏感信息，建议放入 Cursor 的 Secrets（注入为环境变量），不要写入仓库或明文分发。

## 3. 一键执行（推荐）

```sh
sudo TS_AUTHKEY="tskey-auth-xxxx" PANEL_PASSWORD='Str0ng@Pass' bash ops/vm-init.sh
```

脚本会依次：安装并启动 Tailscale（userspace）→ 用 authkey 登录 → 安装并启动 Docker（fuse-overlayfs）→ 安装并启动 1Panel → 安装自愈脚本与看护循环 → 打印验证结果。重复运行安全（已安装/已运行的组件自动跳过）。

## 4. 手动步骤（对照参考）

### 4.1 Tailscale（userspace networking）

```sh
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo systemctl disable --now tailscaled 2>/dev/null || true   # 无 systemd 时忽略
sudo tailscaled --tun=userspace-networking \
  --outbound-http-proxy-listen=localhost:1054 \
  --socks5-server=localhost:1055 >/tmp/tailscaled.log 2>&1 &
sudo tailscale up --authkey="$TS_AUTHKEY" --hostname=cursor-cloud-agent
```

让流量走 Tailscale 的 shell 中导出代理变量（不建议全局设置）：

```sh
export ALL_PROXY=socks5h://localhost:1055/ HTTP_PROXY=http://localhost:1054/ HTTPS_PROXY=http://localhost:1054/
```

### 4.2 Docker（fuse-overlayfs + iptables-legacy）

```sh
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce=5:28.5.2-1~ubuntu.24.04~noble docker-ce-cli=5:28.5.2-1~ubuntu.24.04~noble \
  containerd.io docker-buildx-plugin docker-compose-plugin fuse-overlayfs \
  -o Dpkg::Options::=--force-confold
printf '%s\n' '{' '  "storage-driver": "fuse-overlayfs"' '}' | sudo tee /etc/docker/daemon.json
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
sudo dockerd >/tmp/dockerd.log 2>&1 &
sudo docker run --rm hello-world   # 验证
```

> 说明：`fuse.conf` 等配置文件的交互式提示用 `-o Dpkg::Options::=--force-confold` 规避；若仍有半装包，运行 `sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a --force-confold`。若改用 Docker 29+，需在 `daemon.json` 关闭 `containerd-snapshotter` 才能配合 fuse-overlayfs。

### 4.3 1Panel（无 systemd，直接运行二进制）

1Panel 官方 `install.sh` 依赖 systemd 且密码读取走 `/dev/tty`（非交互会卡住），故此处改为手动部署：

```sh
VER=$(curl -s https://resource.fit2cloud.com/1panel/package/stable/latest)
cd /tmp && curl -sLOk "https://resource.fit2cloud.com/1panel/package/stable/${VER}/release/1panel-${VER}-linux-amd64.tar.gz"
tar xzf 1panel-${VER}-linux-amd64.tar.gz && cd 1panel-${VER}-linux-amd64
sudo cp ./1panel /usr/local/bin/ && sudo chmod +x /usr/local/bin/1panel && sudo ln -sf /usr/local/bin/1panel /usr/bin/1panel
sudo cp ./1pctl /usr/local/bin/ && sudo chmod +x /usr/local/bin/1pctl && sudo ln -sf /usr/local/bin/1pctl /usr/bin/1pctl
# 写入配置（端口/入口/账号/密码/语言/基础目录）
sudo sed -i -e "s#BASE_DIR=.*#BASE_DIR=/opt#g" -e "s#ORIGINAL_PORT=.*#ORIGINAL_PORT=8090#g" \
  -e "s#ORIGINAL_USERNAME=.*#ORIGINAL_USERNAME=admin#g" -e "s#ORIGINAL_ENTRANCE=.*#ORIGINAL_ENTRANCE=1panel#g" \
  -e "s#ORIGINAL_PASSWORD=.*#ORIGINAL_PASSWORD=1Panel\\@2026#g" -e "s#LANGUAGE=.*#LANGUAGE=zh#g" /usr/local/bin/1pctl
sudo mkdir -p /opt/1panel/geo && sudo cp ./GeoIP.mmdb /opt/1panel/geo/ && sudo cp -r ./lang /usr/local/bin/ && sudo cp -rf ./initscript /opt/1panel/
sudo /usr/bin/1panel >/tmp/1panel.log 2>&1 &   # 首次启动时从 1pctl 读取 ORIGINAL_* 初始化
```

密码中的 `!@#$%*_,.?` 需在 sed 中转义（如 `@` → `\@`）。

## 5. 验证

```sh
sudo tailscale status                       # 本节点应为已连接（Running）
sudo tailscale ip -4                         # 返回 100.x.y.z
sudo docker version                          # Server 正常
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/1panel   # 期望 200
sudo 1pctl user-info                         # 面板地址/账号/密码
```

浏览器打开 `http://127.0.0.1:8090/1panel`，勾选许可协议后用 `admin` / 你的密码登录，进入“概览”即成功。

## 6. 稳定性（自愈与守护）

- 自动化脚本会生成 `/usr/local/bin/vm-services-ensure.sh`（幂等）：检测并按需拉起 `dockerd`、`tailscaled`（并用 `~/.config/tailscale/authkey` 或 `$TS_AUTHKEY` 重新登录）、`1panel`。
- 默认启动一个 60s 的自愈看护循环（`setsid` 后台）。掉线会自动恢复。
- 手动触发一次自愈：`sudo /usr/local/bin/vm-services-ensure.sh`。
- 由于无 systemd，VM 重启后需重新执行 `bash ops/vm-init.sh`（或 `vm-services-ensure.sh`）拉起服务；把 `TS_AUTHKEY` 存为 Secret 可让全新 VM 免交互重连。

## 7. 故障排查

- Tailscale 处于 `NeedsLogin`：确认 `TS_AUTHKEY` 有效且未过期；用可重用、非 ephemeral 的 key。
- Tailscale 无法作为 exit node：userspace 模式的预期限制；作为普通节点被访问不受影响。
- `dockerd` 启动失败：查看 `/tmp/dockerd.log`；确认 `daemon.json` 为 `fuse-overlayfs` 且 iptables 为 legacy。
- 1Panel 打不开：必须带安全入口路径（`/1panel`）；查看 `/tmp/1panel.log`；端口占用改 `PANEL_PORT`。
- apt 交互式 conffile 卡住：加 `-o Dpkg::Options::=--force-confold` 或运行 `dpkg --configure -a --force-confold`。

## 8. 卸载

```sh
sudo pkill -f '/usr/bin/1panel'; sudo 1pctl uninstall   # 按提示确认
sudo tailscale down; sudo tailscale logout
sudo pkill -x tailscaled; sudo pkill -x dockerd
sudo pkill -f vm-services-ensure.sh
```
