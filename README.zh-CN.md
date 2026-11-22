<h1 align="center">Browser Rex</h1>

<p align="center">
  <a href="README.md">English</a> &nbsp; / &nbsp; <strong>简体中文</strong>
</p>

<p align="center"><strong>支持原生 Rex 主机的自托管浏览器终端</strong></p>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> &nbsp; / &nbsp;
  <a href="docs/usage.md#systemd">systemd 部署</a> &nbsp; / &nbsp;
  <a href="docs/usage.md">配置参考</a> &nbsp; / &nbsp;
  <a href="SPEC.md">协议支持</a>
</p>

---

## 快速开始

在 [Releases](https://github.com/pentaoa/browser-rex/releases) 下载适合 Linux AMD64 或 ARM64 的压缩包，按 `SHA256SUMS` 校验后解压，用普通账号运行 `bin/browser-rex`。默认的 Shell 沙箱需要 Linux 用户命名空间。

也可以用 Go 1.24+ 和 Bun 从源码构建：

```sh
make install-dev
make build
bin/browser-rex
```

打开 <http://127.0.0.1:8080>。单个二进制包含网页、字体和 Ghostty VT。默认只在回环地址监听，Shell 使用命名空间隔离。可通过 SSH 转发或 HTTPS [远程访问](docs/usage.md#remote-access)。

## 功能

| 功能 | 使用方式 |
| --- | --- |
| 会话 | 浏览器断开后 Shell 继续运行，重连时按字节位置回放终端输出。 |
| 标签和分屏 | 默认使用纵向标签，可切换横排。支持分屏、查找和导出。 |
| 主机 | 在网页内管理连接，在本机与已有 Rex 主机间切换。 |
| 输入 | 内嵌和独立页均使用浏览器原生文本输入，支持中文输入法。 |
| 外观 | 从工作区菜单切换亮色、暗色或跟随系统。 |

Go 服务管理 PTY、会话和布局，Ghostty VT 提供终端状态与导出。输出存入有界分页，实时发送与重连回放共享已写入的字节。网页在会话或终端元数据变化时再读取完整视图。详见[服务与协议契约](SPEC.md)。

## 验证

```sh
make check race smoke
make browser-smoke
```

项目以 MIT 授权的 [rcarmo/rexweb](https://github.com/rcarmo/rexweb) 为起点。原作者署名与组件许可见 [LICENSE](LICENSE) 和[第三方声明](THIRD_PARTY_NOTICES.md)。
