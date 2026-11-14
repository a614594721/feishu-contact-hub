// Package lark 实现飞书 OAuth（设备流 + 刷新）与 OpenAPI 调用。
package lark

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	openBase     = "https://open.feishu.cn"
	accountsBase = "https://accounts.feishu.cn"

	scopeDevice = "offline_access"
)

// Token 保存于 token.json；字段名与飞书 OAuth 响应对齐。
type Token struct {
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
	Scope            string    `json:"scope,omitempty"`
	UserOpenID       string    `json:"user_open_id,omitempty"`
	UserName         string    `json:"user_name,omitempty"`
	LastAlertAt      time.Time `json:"last_alert_at,omitempty"` // token 寿命告警节流
}

// Provider 负责 token 的加载与自动刷新。并发安全。
type Provider struct {
	appID, appSecret string
	http             *http.Client

	mu    sync.Mutex
	token *Token
	// 刷新去重：并发 401 时只触发一次刷新
	refreshing  bool
	lastRefresh time.Time
}

func NewProvider(appID, appSecret string, t *Token) *Provider {
	return &Provider{appID: appID, appSecret: appSecret, http: &http.Client{Timeout: 30 * time.Second}, token: t}
}

func (p *Provider) Token() *Token {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.token
}

// Current 返回有效的 access token，必要时先刷新（提前 5 分钟刷新）。
func (p *Provider) Current(ctx context.Context) (string, error) {
	p.mu.Lock()
	t := p.token
	p.mu.Unlock()
	if t == nil {
		return "", fmt.Errorf("未登录：先运行 watcher -mode auth")
	}
	if t.AccessToken != "" && time.Now().Before(t.AccessExpiresAt.Add(-5*time.Minute)) {
		return t.AccessToken, nil
	}
	return p.Refresh(ctx)
}

// Refresh 刷新 access token（滚动续期 refresh token）。
func (p *Provider) Refresh(ctx context.Context) (string, error) {
	p.mu.Lock()
	if p.refreshing && time.Since(p.lastRefresh) < 10*time.Second {
		t := p.token
		p.mu.Unlock()
		if t != nil {
			return t.AccessToken, nil
		}
		return "", fmt.Errorf("token 刷新进行中")
	}
	p.refreshing = true
	p.lastRefresh = time.Now()
	rt := ""
	if p.token != nil {
		rt = p.token.RefreshToken
	}
	p.mu.Unlock()

	defer func() { p.mu.Lock(); p.refreshing = false; p.mu.Unlock() }()

	if rt == "" {
		return "", fmt.Errorf("无 refresh_token：应用需在开放平台开启「刷新 user_access_token」并发布版本")
	}

	body, _ := json.Marshal(map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": rt,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, accountsBase+"/oauth/v3/token", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	basic := base64.StdEncoding.EncodeToString([]byte(p.appID + ":" + p.appSecret))
	req.Header.Set("Authorization", "Basic "+basic)

	resp, err := p.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("refresh 请求失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("refresh HTTP %d: %s", resp.StatusCode, trunc(raw, 300))
	}
	var data struct {
		AccessToken           string `json:"access_token"`
		RefreshToken          string `json:"refresh_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Scope                 string `json:"scope"`
		Error                 string `json:"error"`
		ErrorDescription      string `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", fmt.Errorf("refresh 响应解析失败: %w", err)
	}
	if data.Error != "" {
		return "", fmt.Errorf("refresh 失败: %s %s", data.Error, data.ErrorDescription)
	}
	if data.AccessToken == "" {
		return "", fmt.Errorf("refresh 失败: 响应无 access_token")
	}

	p.mu.Lock()
	newRT := data.RefreshToken
	if newRT == "" {
		newRT = p.token.RefreshToken // 有些实现不滚动返回，沿用旧的
	}
	newREx := time.Now().Add(time.Duration(data.RefreshTokenExpiresIn) * time.Second)
	if data.RefreshTokenExpiresIn == 0 {
		newREx = p.token.RefreshExpiresAt
	}
	// 保留身份信息与告警节流时间
	nt := *p.token
	nt.AccessToken = data.AccessToken
	nt.RefreshToken = newRT
	nt.AccessExpiresAt = time.Now().Add(time.Duration(data.ExpiresIn) * time.Second)
	nt.RefreshExpiresAt = newREx
	if data.Scope != "" {
		nt.Scope = data.Scope
	}
	p.token = &nt
	p.mu.Unlock()
	return data.AccessToken, nil
}

// UpdateToken 供外部（auth 模式）写入新 token。
func (p *Provider) UpdateToken(t *Token) {
	p.mu.Lock()
	p.token = t
	p.mu.Unlock()
}

func trunc(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// ---------------------------------------------------------------------------
// 设备流授权
// ---------------------------------------------------------------------------

// DeviceAuth 发起设备授权，返回用户需打开的验证 URL。
func (p *Provider) DeviceAuth(ctx context.Context, scope string) (*DeviceAuthInfo, error) {
	if scope == "" {
		scope = "im:chat:read im:message.p2p_msg:get_as_user"
	}
	if !strings.Contains(scope, scopeDevice) {
		scope += " " + scopeDevice
	}
	form := url.Values{}
	form.Set("client_id", p.appID)
	form.Set("scope", scope)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, accountsBase+"/oauth/v1/device_authorization", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(p.appID+":"+p.appSecret)))

	resp, err := p.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("设备授权请求失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("设备授权 HTTP %d: %s", resp.StatusCode, trunc(raw, 300))
	}
	var d struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
		Error           string `json:"error"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("设备授权响应解析失败: %w", err)
	}
	if d.Error != "" {
		return nil, fmt.Errorf("设备授权失败: %s", d.Error)
	}
	if d.Interval <= 0 {
		d.Interval = 5
	}
	return &DeviceAuthInfo{
		DeviceCode:      d.DeviceCode,
		VerificationURI: d.VerificationURI,
		ExpiresIn:       d.ExpiresIn,
		Interval:        d.Interval,
	}, nil
}

type DeviceAuthInfo struct {
	DeviceCode      string
	VerificationURI string
	ExpiresIn       int
	Interval        int
}

// WaitForDevice 轮询 token 端点直到用户完成授权（RFC 8628）。
func (p *Provider) WaitForDevice(ctx context.Context, info *DeviceAuthInfo) (*Token, error) {
	deadline := time.Now().Add(time.Duration(info.ExpiresIn) * time.Second)
	interval := time.Duration(info.Interval) * time.Second

	for {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		form := url.Values{}
		form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
		form.Set("device_code", info.DeviceCode)
		form.Set("client_id", p.appID)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, accountsBase+"/oauth/v3/token", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(p.appID+":"+p.appSecret)))

		resp, err := p.http.Do(req)
		if err != nil {
			return nil, fmt.Errorf("token 轮询失败: %w", err)
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()

		var d struct {
			AccessToken           string `json:"access_token"`
			RefreshToken          string `json:"refresh_token"`
			ExpiresIn             int64  `json:"expires_in"`
			RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
			Scope                 string `json:"scope"`
			Error                 string `json:"error"`
			ErrorDescription      string `json:"error_description"`
		}
		_ = json.Unmarshal(raw, &d)
		switch {
		case d.AccessToken != "":
			t := &Token{
				AccessToken:      d.AccessToken,
				RefreshToken:     d.RefreshToken,
				AccessExpiresAt:  time.Now().Add(time.Duration(d.ExpiresIn) * time.Second),
				RefreshExpiresAt: time.Now().Add(time.Duration(d.RefreshTokenExpiresIn) * time.Second),
				Scope:            d.Scope,
			}
			if d.RefreshToken == "" {
				return t, fmt.Errorf("授权成功但未返回 refresh_token（应用需在开放平台开启「刷新 user_access_token」并发布版本），token 将在 %s 后失效", t.AccessExpiresAt.Sub(time.Now()).Round(time.Second))
			}
			return t, nil
		case d.Error == "authorization_pending":
			// 正常等待
		case d.Error == "slow_down":
			interval += 5 * time.Second
		case d.Error != "":
			return nil, fmt.Errorf("设备流失败: %s %s", d.Error, d.ErrorDescription)
		default:
			if resp.StatusCode >= 500 {
				// 服务端错误，退避重试
			} else {
				return nil, fmt.Errorf("token 端点 HTTP %d: %s", resp.StatusCode, trunc(raw, 300))
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("设备授权超时（%d 秒）", info.ExpiresIn)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

// UserInfo 拉取当前用户 open_id / 姓名。
func (p *Provider) UserInfo(ctx context.Context, accessToken string) (openID, name string, err error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, openBase+"/open-apis/authen/v1/user_info", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := p.http.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var d struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			OpenID string `json:"open_id"`
			Name   string `json:"name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return "", "", fmt.Errorf("user_info 解析失败: %w", err)
	}
	if d.Code != 0 {
		return "", "", fmt.Errorf("user_info code=%d %s", d.Code, d.Msg)
	}
	return d.Data.OpenID, d.Data.Name, nil
}
