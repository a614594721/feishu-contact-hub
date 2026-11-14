// Package poller 私聊轮询核心。
package poller

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"lark-p2p-watcher/internal/config"
	"lark-p2p-watcher/internal/lark"
	"lark-p2p-watcher/internal/notify"
	"lark-p2p-watcher/internal/sdnotify"
	"lark-p2p-watcher/internal/store"
)

type Poller struct {
	cfg     *config.Config
	prov    *lark.Provider
	st      *store.Store
	alert   *notify.Notifier
	sd      *sdnotify.Notifier
	logf    func(format string, args ...any)
	outFile *os.File

	// 运行统计
	mu         sync.Mutex
	rounds     int64
	failStreak int
}

func New(cfg *config.Config, prov *lark.Provider, st *store.Store, alert *notify.Notifier, sd *sdnotify.Notifier) (*Poller, error) {
	p := &Poller{cfg: cfg, prov: prov, st: st, alert: alert, sd: sd, logf: defaultLog(cfg)}
	if cfg.OutputFile != "" {
		f, err := os.OpenFile(cfg.OutputFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return nil, fmt.Errorf("打开输出文件失败: %w", err)
		}
		p.outFile = f
	}
	return p, nil
}

func defaultLog(cfg *config.Config) func(string, ...any) {
	loc, _ := time.LoadLocation(cfg.TZ)
	if loc == nil {
		loc = time.Local
	}
	return func(format string, args ...any) {
		fmt.Printf(time.Now().In(loc).Format("2006-01-02 15:04:05 ")+format+"\n", args...)
	}
}

// Run 主循环：固定节奏 Ticker + 优雅退出。
func (p *Poller) Run(ctx context.Context) error {
	ticker := time.NewTicker(p.cfg.Interval)
	defer ticker.Stop()

	compactEvery := 6 * time.Hour
	compact := time.NewTicker(compactEvery)
	defer compact.Stop()

	p.sd.Ready()
	p.logf("监听已启动：间隔 %s，重叠窗口 %s，并发 %d", p.cfg.Interval, p.cfg.Overlap, p.cfg.Concurrency)
	p.checkTokenLifetime(ctx) // 启动即检查一次

	for {
		p.pollOnce(ctx)
		select {
		case <-ctx.Done():
			p.sd.Stopping()
			p.logf("收到退出信号，状态已落盘，再见")
			return nil
		case <-compact.C:
			if err := p.st.CompactSeen(); err != nil {
				p.logf("seen journal 压缩失败: %v", err)
			}
		case <-ticker.C:
		}
	}
}

// pollOnce 一轮扫描：列会话 → 并发拉增量 → 去重 → 输出 → 推进游标。
func (p *Poller) pollOnce(ctx context.Context) {
	p.mu.Lock()
	p.rounds++
	p.mu.Unlock()

	tok := p.prov.Token()
	myID := ""
	if tok != nil {
		myID = tok.UserOpenID
	}

	cursor, err := p.st.LoadCursor()
	if err != nil {
		p.logf("游标读取失败: %v", err)
		return
	}
	startUnix := cursor - int64(p.cfg.Overlap.Seconds())
	endUnix := time.Now().Unix()

	chats, err := p.prov.ListP2PChats(ctx)
	if err != nil {
		p.handleFailure(ctx, err)
		return
	}

	type result struct {
		chat lark.Chat
		msgs []lark.Message
		err  error
	}
	results := make([]result, len(chats))

	sem := make(chan struct{}, p.cfg.Concurrency)
	var wg sync.WaitGroup
	for i, ch := range chats {
		wg.Add(1)
		go func(i int, ch lark.Chat) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			msgs, err := p.prov.ListChatMessages(ctx, ch.ChatID, startUnix, endUnix, p.cfg.PageSize)
			results[i] = result{chat: ch, msgs: msgs, err: err}
		}(i, ch)
	}
	wg.Wait()

	p.mu.Lock()
	p.failStreak = 0
	p.mu.Unlock()

	var fresh []lark.Message
	failed := 0
	for _, r := range results {
		if r.err != nil {
			failed++
			continue
		}
		for _, m := range r.msgs {
			if m.Deleted || m.Sender.ID == myID || m.Sender.ID == "" {
				continue // 自己发的 / 已删除 / 系统空 sender
			}
			if p.st.IsSeen(m.MessageID) {
				continue
			}
			m.ChatName = r.chat.Name
			fresh = append(fresh, m)
		}
	}

	// 顺序：先写 seen + 输出，再推进游标（崩溃在中间 → 重启后重叠窗口重放，靠 seen 去重，宁可重复不丢）
	for _, m := range fresh {
		b, _ := json.Marshal(m)
		if p.outFile != nil {
			if _, err := p.outFile.Write(append(b, '\n')); err != nil {
				p.logf("输出文件写入失败: %v", err)
			}
		} else {
			os.Stdout.Write(append(b, '\n'))
		}
		_ = p.st.MarkSeen(m.MessageID)
	}
	if err := p.st.SaveCursor(endUnix); err != nil {
		p.logf("游标写入失败: %v", err)
	}

	if len(fresh) > 0 {
		p.logf("本轮：%d 会话（%d 失败），新消息 %d 条", len(chats), failed, len(fresh))
	}
	p.checkTokenLifetime(ctx)
}

// handleFailure 连续 N 轮失败才告警（瞬时抖动不打扰）。
func (p *Poller) handleFailure(ctx context.Context, err error) {
	p.mu.Lock()
	p.failStreak++
	n := p.failStreak
	p.mu.Unlock()
	p.logf("本轮失败（连续 %d 轮）: %v", n, err)
	if n == 10 {
		_ = p.alert.Send(ctx, fmt.Sprintf("[lark-watcher] 连续 10 轮拉取失败：%v。请检查服务与授权。", err))
	}
}

// checkTokenLifetime token 寿命监控：refresh_token 剩余寿命不足时告警（带节流）。
func (p *Poller) checkTokenLifetime(ctx context.Context) {
	t := p.prov.Token()
	if t == nil || t.RefreshToken == "" {
		return
	}
	left := time.Until(t.RefreshExpiresAt)
	if left > p.cfg.TokenAlertBefore {
		return
	}
	if !t.LastAlertAt.IsZero() && time.Since(t.LastAlertAt) < p.cfg.TokenAlertEvery {
		return
	}
	msg := fmt.Sprintf("[lark-watcher] refresh_token 剩余寿命 %s（不足 %s）。请在服务器上执行重新授权：\n"+
		"docker exec -it lark-watcher /lark-watcher -mode auth\n（扫码完成后服务自动恢复，无需重启）",
		left.Round(time.Hour), p.cfg.TokenAlertBefore)
	if err := p.alert.Send(ctx, msg); err != nil {
		p.logf("token 寿命告警发送失败: %v", err)
	} else {
		p.logf("已发送 token 寿命告警（剩余 %s）", left.Round(time.Hour))
	}
	t.LastAlertAt = time.Now()
	_ = p.st.SaveToken(t)
}
