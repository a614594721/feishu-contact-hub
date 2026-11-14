// Package config 加载环境变量配置。
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	AppID     string
	AppSecret string

	// 轮询参数
	Interval    time.Duration // 轮询间隔（Ticker 固定节奏）
	Overlap     time.Duration // 时间窗口重叠，防边界丢消息
	Concurrency int           // 并发拉取的会话数
	PageSize    int

	// 数据路径
	DataDir    string // token.json / cursor / seen journal
	OutputFile string // 新消息 JSONL 输出；空 = 仅 stdout

	// token 寿命告警
	AlertWebhook     string // 告警 webhook URL；空 = 仅日志
	AlertWebhookType string // wecom | feishu
	TokenAlertBefore time.Duration
	TokenAlertEvery  time.Duration // 同一告警的节流间隔

	TZ string // 日志时区，默认 Asia/Shanghai
}

func Load() (*Config, error) {
	c := &Config{
		AppID:     env("LARK_APP_ID", ""),
		AppSecret: env("LARK_APP_SECRET", ""),

		Interval:    dur("WATCH_INTERVAL", 5*time.Second),
		Overlap:     dur("WATCH_OVERLAP", 90*time.Second),
		Concurrency: num("WATCH_CONCURRENCY", 6),
		PageSize:    num("WATCH_PAGE_SIZE", 50),

		DataDir:    env("DATA_DIR", "/data"),
		OutputFile: env("OUTPUT_FILE", ""),

		AlertWebhook:     env("ALERT_WEBHOOK", ""),
		AlertWebhookType: env("ALERT_WEBHOOK_TYPE", "wecom"),
		TokenAlertBefore: dur("TOKEN_ALERT_BEFORE", 72*time.Hour),
		TokenAlertEvery:  dur("TOKEN_ALERT_EVERY", 12*time.Hour),

		TZ: env("TZ", "Asia/Shanghai"),
	}
	if c.Interval < time.Second {
		c.Interval = time.Second
	}
	if c.Concurrency < 1 {
		c.Concurrency = 1
	}
	if c.PageSize < 1 || c.PageSize > 50 {
		c.PageSize = 50
	}
	return c, nil
}

func (c *Config) TokenPath() string  { return c.DataDir + "/token.json" }
func (c *Config) CursorPath() string { return c.DataDir + "/cursor" }
func (c *Config) SeenPath() string   { return c.DataDir + "/seen.journal" }
func (c *Config) StateLog() string   { return c.DataDir + "/state.log" }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func dur(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %s=%q 解析失败，用默认值 %s\n", k, v, def)
		return def
	}
	return d
}

func num(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %s=%q 不是整数，用默认值 %d\n", k, v, def)
		return def
	}
	return n
}
