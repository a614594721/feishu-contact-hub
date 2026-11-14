// lark-p2p-watcher：监听自己飞书账号收到的私聊消息。
//
// 模式：
//
//	watcher -mode auth    设备流授权（打印 URL，等待扫码，写入 token）
//	watcher               轮询守护（默认，systemd/docker 常驻）
//	watcher -mode status  查看登录态与 token 寿命
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "time/tzdata" // 内嵌时区数据库（scratch 镜像无系统 tzdata）

	"lark-p2p-watcher/internal/config"
	"lark-p2p-watcher/internal/lark"
	"lark-p2p-watcher/internal/notify"
	"lark-p2p-watcher/internal/poller"
	"lark-p2p-watcher/internal/sdnotify"
	"lark-p2p-watcher/internal/store"
)

func main() {
	mode := flag.String("mode", "serve", "运行模式：auth | serve | status")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		fatal("配置加载失败: %v", err)
	}
	if cfg.AppID == "" || cfg.AppSecret == "" {
		fatal("缺少 LARK_APP_ID / LARK_APP_SECRET 环境变量")
	}

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		fatal("存储初始化失败: %v", err)
	}

	tok, err := st.LoadToken()
	if err != nil {
		fatal("token 加载失败: %v", err)
	}
	prov := lark.NewProvider(cfg.AppID, cfg.AppSecret, tok)

	switch *mode {
	case "auth":
		runAuth(cfg, st, prov)
	case "status":
		runStatus(cfg, prov)
	default:
		runServe(cfg, st, prov)
	}
}

func runAuth(cfg *config.Config, st *store.Store, prov *lark.Provider) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	fmt.Println("发起设备流授权（scope: im:chat:read im:message.p2p_msg:get_as_user offline_access）...")
	info, err := prov.DeviceAuth(ctx, "")
	if err != nil {
		fatal("设备授权失败: %v", err)
	}
	fmt.Printf("\n请在浏览器打开以下链接并完成授权（%d 分钟内有效）：\n\n  %s\n\n",
		info.ExpiresIn/60, info.VerificationURI)
	fmt.Println("等待授权完成...")

	tok, err := prov.WaitForDevice(ctx, info)
	if err != nil {
		fatal("授权失败: %v", err)
	}
	openID, name, err := prov.UserInfo(ctx, tok.AccessToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "获取用户信息失败（不影响 token）: %v\n", err)
	}
	tok.UserOpenID, tok.UserName = openID, name
	prov.UpdateToken(tok)
	if err := st.SaveToken(tok); err != nil {
		fatal("token 保存失败: %v", err)
	}
	fmt.Printf("授权成功：用户 %s（%s）\n", name, openID)
	fmt.Printf("access_token 寿命 %s；refresh_token 寿命 %s\n",
		time.Until(tok.AccessExpiresAt).Round(time.Second),
		time.Until(tok.RefreshExpiresAt).Round(time.Hour))
	fmt.Printf("已写入 %s\n", cfg.TokenPath())
}

func runStatus(cfg *config.Config, prov *lark.Provider) {
	t := prov.Token()
	if t == nil {
		fmt.Println("未登录。运行: watcher -mode auth")
		os.Exit(1)
	}
	fmt.Printf("用户:        %s (%s)\n", t.UserName, t.UserOpenID)
	fmt.Printf("scope:       %s\n", t.Scope)
	fmt.Printf("access_token 剩余:  %s\n", time.Until(t.AccessExpiresAt).Round(time.Second))
	if t.RefreshToken != "" {
		fmt.Printf("refresh_token 剩余: %s\n", time.Until(t.RefreshExpiresAt).Round(time.Hour))
	} else {
		fmt.Println("refresh_token: 无（需在开放平台开启「刷新 user_access_token」）")
	}
}

func runServe(cfg *config.Config, st *store.Store, prov *lark.Provider) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if prov.Token() == nil {
		fatal("未登录：先运行 watcher -mode auth")
	}
	// 启动即试刷新一次：验证 refresh 链路（token 过期则此处报错并快速失败）
	if _, err := prov.Refresh(ctx); err != nil {
		fatal("启动自检失败（refresh 链路异常）: %v", err)
	}
	_ = st.SaveToken(prov.Token())

	alert := notify.New(cfg.AlertWebhook, cfg.AlertWebhookType)
	sd := sdnotify.New()

	p, err := poller.New(cfg, prov, st, alert, sd)
	if err != nil {
		fatal("初始化失败: %v", err)
	}
	if err := p.Run(ctx); err != nil {
		fatal("运行异常: %v", err)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "fatal: "+format+"\n", args...)
	os.Exit(1)
}
