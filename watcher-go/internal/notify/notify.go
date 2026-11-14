// Package notify 告警推送（企业微信 / 飞书群机器人 webhook）。
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Notifier struct {
	webhook string
	kind    string // wecom | feishu
	client  *http.Client
}

func New(webhook, kind string) *Notifier {
	if kind == "" {
		kind = detect(webhook)
	}
	return &Notifier{
		webhook: webhook,
		kind:    kind,
		client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func detect(webhook string) string {
	switch {
	case strings.Contains(webhook, "qyapi.weixin.qq.com"):
		return "wecom"
	case strings.Contains(webhook, "open.feishu.cn"), strings.Contains(webhook, "open.larksuite.com"):
		return "feishu"
	}
	return "wecom"
}

// Send 发送文本告警。webhook 为空时只打日志（调用方处理）。
func (n *Notifier) Send(ctx context.Context, text string) error {
	if n.webhook == "" {
		fmt.Printf("[alert] (未配置 webhook) %s\n", text)
		return nil
	}
	var body []byte
	switch n.kind {
	case "feishu":
		body, _ = json.Marshal(map[string]any{
			"msg_type": "text",
			"content":  map[string]string{"text": text},
		})
	default: // wecom
		body, _ = json.Marshal(map[string]any{
			"msgtype": "text",
			"text":    map[string]string{"content": text},
		})
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.webhook, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := n.client.Do(req)
	if err != nil {
		return fmt.Errorf("告警发送失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("告警发送 HTTP %d", resp.StatusCode)
	}
	return nil
}
