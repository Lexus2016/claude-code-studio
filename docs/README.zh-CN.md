# Claude Code Studio：简体中文入门

Claude Code Studio 是在本机运行的 Claude Code CLI 网页和桌面工作区，提供聊天、Kanban 任务和项目管理。

这是简明入门指南，不是完整翻译。完整功能和升级说明请参阅 [English README](../README.md)。

## 演示

[观看 30 秒演示](media/claude-code-studio-promo.mp4)

## 安装

需要先安装并登录 Claude Code CLI。网页版本还需要 Node.js；建议使用 22.13 或更高版本，以使用内置 SQLite。较旧的受支持 Node.js 版本可能需要原生编译工具。

```bash
npx github:Lexus2016/claude-code-studio
```

打开 http://localhost:3000，设置密码，然后添加项目。

也可以从 [GitHub Releases](https://github.com/Lexus2016/claude-code-studio/releases/latest) 下载桌面安装包。请按操作系统选择文件；macOS 版本面向 Apple Silicon。

## 安全边界

Studio 会通过 Claude Code 在本机执行命令和修改文件，并使用 `--dangerously-skip-permissions`。只对可信项目使用它，并保留备份。网页版默认仅监听 localhost；不要直接向公网开放端口。远程访问、Docker 和反向代理的安全设置请参阅英文 README。

## 反馈

请在 [Issues](https://github.com/Lexus2016/claude-code-studio/issues) 提交可复现的问题。不要公开 API 密钥、会话 cookies、SSH 凭据或私人项目文件。开发与测试说明见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
