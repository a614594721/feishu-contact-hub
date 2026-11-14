package lark

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

// messageTZ 消息可读时间所用时区（默认 Asia/Shanghai，可用 TZ 环境变量覆盖）。
var messageTZ = func() *time.Location {
	loc, err := time.LoadLocation(envOr("TZ", "Asia/Shanghai"))
	if err != nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}()

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// APIError 业务错误（飞书 code != 0）。401 类错误由调用方触发刷新后重试。
type APIError struct {
	Code int
	Msg  string
	HTTP int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("lark api code=%d http=%d: %s", e.Code, e.HTTP, e.Msg)
}

// TokenExpired 判断是否 token 失效类错误（99991663: invalid access token）。
func (e *APIError) TokenExpired() bool {
	return e.HTTP == 401 || e.Code == 99991663 || e.Code == 99991661 || e.Code == 99991668
}

func (p *Provider) get(ctx context.Context, path string, query map[string]string, out any) error {
	tok, err := p.Current(ctx)
	if err != nil {
		return err
	}
	return p.getWithToken(ctx, tok, path, query, out)
}

func (p *Provider) getWithToken(ctx context.Context, tok, path string, query map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openBase+path, nil)
	if err != nil {
		return err
	}
	q := req.URL.Query()
	for k, v := range query {
		q.Set(k, v)
	}
	req.URL.RawQuery = q.Encode()
	req.Header.Set("Authorization", "Bearer "+tok)

	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var env struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("%s 响应解析失败(HTTP %d): %s", path, resp.StatusCode, trunc(raw, 200))
	}
	if env.Code != 0 {
		return &APIError{Code: env.Code, Msg: env.Msg, HTTP: resp.StatusCode}
	}
	if out != nil {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("%s data 解析失败: %w", path, err)
		}
	}
	return nil
}

// GetWithRetry 401 时自动刷新一次再重试。
func (p *Provider) GetWithRetry(ctx context.Context, path string, query map[string]string, out any) error {
	err := p.get(ctx, path, query, out)
	if err == nil {
		return nil
	}
	ae, ok := err.(*APIError)
	if !ok || !ae.TokenExpired() {
		return err
	}
	// 强制刷新后重试一次
	if _, rerr := p.Refresh(ctx); rerr != nil {
		return fmt.Errorf("token 失效且刷新失败: %w", rerr)
	}
	tok, _ := p.Current(ctx)
	return p.getWithToken(ctx, tok, path, query, out)
}

// ---------------------------------------------------------------------------
// 会话与消息模型
// ---------------------------------------------------------------------------

// Chat 单聊会话。
type Chat struct {
	ChatID      string `json:"chat_id"`
	Name        string `json:"name"`
	ChatMode    string `json:"chat_mode"`
	P2PTargetID string `json:"p2p_target_id,omitempty"`
}

// Sender 消息发送者。
// 服务端在 with_sender_name=true 时返回 sender_name（默认语言显示名），无需通讯录权限。
type Sender struct {
	ID         string `json:"id"`
	IDType     string `json:"id_type,omitempty"`
	Name       string `json:"name,omitempty"`
	SenderName string `json:"sender_name,omitempty"`
	SenderType string `json:"sender_type"`
}

// DisplayName 返回可读显示名（优先服务端 sender_name）。
func (s Sender) DisplayName() string {
	if s.SenderName != "" {
		return s.SenderName
	}
	if s.Name != "" {
		return s.Name
	}
	return s.ID
}

// Message 会话内一条消息（原始字段 + 解析后的可读内容）。
type Message struct {
	MessageID      string `json:"message_id"`
	ChatID         string `json:"chat_id"`
	MsgType        string `json:"msg_type"`
	Content        string `json:"content"`          // 已解析的可读文本
	CreateTime     int64  `json:"create_time"`      // 毫秒时间戳（机器友好）
	CreateTimeText string `json:"create_time_text"` // 本地可读时间
	Deleted        bool   `json:"deleted"`
	Sender         Sender `json:"sender"`
	// 附加上下文（由 poller 填充）
	ChatName string `json:"chat_name,omitempty"`
}

// ListP2PChats 分页列出当前用户全部单聊。
func (p *Provider) ListP2PChats(ctx context.Context) ([]Chat, error) {
	var out []Chat
	pageToken := ""
	for i := 0; i < 20; i++ { // 硬上限 20 页（2000 会话）
		q := map[string]string{
			"user_id_type": "open_id",
			"sort_type":    "ByActiveTimeDesc",
			"types":        "p2p",
			"page_size":    "100",
		}
		if pageToken != "" {
			q["page_token"] = pageToken
		}
		var d struct {
			Items     []Chat `json:"items"`
			HasMore   bool   `json:"has_more"`
			PageToken string `json:"page_token"`
		}
		if err := p.GetWithRetry(ctx, "/open-apis/im/v1/chats", q, &d); err != nil {
			return out, err
		}
		out = append(out, d.Items...)
		if !d.HasMore || d.PageToken == "" {
			break
		}
		pageToken = d.PageToken
	}
	return out, nil
}

// rawMessage OpenAPI 原始消息结构。
type rawMessage struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	MsgType   string `json:"msg_type"`
	Body      struct {
		Content string `json:"content"`
	} `json:"body"`
	CreateTime string `json:"create_time"`
	Deleted    *bool  `json:"deleted"`
	Sender     Sender `json:"sender"`
}

// ListChatMessages 拉取会话 [startUnix, endUnix] 秒窗口内消息（升序）。
func (p *Provider) ListChatMessages(ctx context.Context, chatID string, startUnix, endUnix int64, pageSize int) ([]Message, error) {
	var out []Message
	pageToken := ""
	for i := 0; i < 10; i++ {
		q := map[string]string{
			"container_id_type":     "chat",
			"container_id":          chatID,
			"sort_type":             "ByCreateTimeAsc",
			"page_size":             strconv.Itoa(pageSize),
			"start_time":            strconv.FormatInt(startUnix, 10),
			"end_time":              strconv.FormatInt(endUnix, 10),
			"card_msg_content_type": "raw_card_content",
			"with_sender_name":      "true",
		}
		if pageToken != "" {
			q["page_token"] = pageToken
		}
		var d struct {
			Items     []rawMessage `json:"items"`
			HasMore   bool         `json:"has_more"`
			PageToken string       `json:"page_token"`
		}
		if err := p.GetWithRetry(ctx, "/open-apis/im/v1/messages", q, &d); err != nil {
			return out, err
		}
		for _, m := range d.Items {
			ct, _ := strconv.ParseInt(m.CreateTime, 10, 64)
			del := m.Deleted != nil && *m.Deleted
			s := m.Sender
			if s.Name == "" {
				s.Name = s.DisplayName() // 统一填充可读显示名
			}
			out = append(out, Message{
				MessageID:      m.MessageID,
				ChatID:         m.ChatID,
				MsgType:        m.MsgType,
				Content:        readableContent(m.MsgType, m.Body.Content),
				CreateTime:     ct,
				CreateTimeText: time.UnixMilli(ct).In(messageTZ).Format("2006-01-02 15:04:05"),
				Deleted:        del,
				Sender:         s,
			})
		}
		if !d.HasMore || d.PageToken == "" {
			break
		}
		pageToken = d.PageToken
	}
	return out, nil
}

// readableContent 把各 msg_type 的 content JSON 转成可读文本。
func readableContent(msgType, raw string) string {
	switch msgType {
	case "text":
		var c struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(raw), &c) == nil {
			return c.Text
		}
	case "post":
		// 富文本：抽取全部 text 段拼起来
		var c map[string]any
		if json.Unmarshal([]byte(raw), &c) == nil {
			return extractPostText(c)
		}
	case "interactive":
		return "[卡片消息]"
	}
	if raw == "" {
		return ""
	}
	return "[" + msgType + "]"
}

func extractPostText(v any) string {
	switch x := v.(type) {
	case map[string]any:
		// post 结构: {title, content:[[{"tag":"text","text":...},...]]}
		if title, ok := x["title"].(string); ok && title != "" {
			return title
		}
		var sb []byte
		if content, ok := x["content"].([]any); ok {
			for _, para := range content {
				if seg, ok := para.([]any); ok {
					for _, s := range seg {
						if m, ok := s.(map[string]any); ok {
							if t, ok := m["text"].(string); ok {
								sb = append(sb, t...)
							}
						}
					}
				}
			}
		}
		return string(sb)
	}
	return ""
}
