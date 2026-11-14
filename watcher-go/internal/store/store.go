// Package store 基于文件的持久化：token、游标、去重 journal。
// 设计原则：零依赖、崩溃安全（追加 + 原子 rename）、重启后重叠窗口重放不丢不重。
package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"lark-p2p-watcher/internal/lark"
)

type Store struct {
	dir  string
	seen map[string]struct{}
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, seen: make(map[string]struct{})}
	if err := s.loadSeen(); err != nil {
		return nil, err
	}
	return s, nil
}

// ---------------------------------------------------------------------------
// token.json
// ---------------------------------------------------------------------------

func (s *Store) LoadToken() (*lark.Token, error) {
	b, err := os.ReadFile(s.dir + "/token.json")
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var t lark.Token
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, fmt.Errorf("token.json 解析失败: %w", err)
	}
	return &t, nil
}

func (s *Store) SaveToken(t *lark.Token) error {
	return writeJSONAtomic(s.dir+"/token.json", t, 0o600)
}

// ---------------------------------------------------------------------------
// cursor：epoch 秒，原子写（tmp + rename）
// ---------------------------------------------------------------------------

func (s *Store) LoadCursor() (int64, error) {
	b, err := os.ReadFile(s.dir + "/cursor")
	if err != nil {
		if os.IsNotExist(err) {
			return time.Now().Unix(), nil // 首次：从当前开始
		}
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("cursor 损坏: %w", err)
	}
	return n, nil
}

func (s *Store) SaveCursor(unix int64) error {
	tmp := s.dir + "/cursor.tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(unix, 10)+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.dir+"/cursor")
}

// ---------------------------------------------------------------------------
// seen journal：一行一个 message_id（加时间戳便于清理）
// ---------------------------------------------------------------------------

func (s *Store) loadSeen() error {
	f, err := os.Open(s.seenJournal())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	cutoff := time.Now().Add(-7 * 24 * time.Hour).Unix()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 4<<10), 16<<10)
	for sc.Scan() {
		line := sc.Text()
		// 格式: <unix>\t<message_id>
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			s.seen[parts[0]] = struct{}{} // 容错：旧行式纯 id
			continue
		}
		ts, _ := strconv.ParseInt(parts[0], 10, 64)
		if ts < cutoff {
			continue // 超过 7 天的记录不加载（仍在文件里，compact 时清）
		}
		s.seen[parts[1]] = struct{}{}
	}
	return nil
}

func (s *Store) seenJournal() string { return s.dir + "/seen.journal" }

// IsSeen 去重查询。
func (s *Store) IsSeen(id string) bool {
	_, ok := s.seen[id]
	return ok
}

// MarkSeen 记录并追加写入 journal（行级 append，O_APPEND 原子）。
func (s *Store) MarkSeen(id string) error {
	s.seen[id] = struct{}{}
	f, err := os.OpenFile(s.seenJournal(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "%d\t%s\n", time.Now().Unix(), id)
	return err
}

// CompactSeen 清理 7 天前的记录（后台周期调用，防 journal 无限增长）。
func (s *Store) CompactSeen() error {
	in, err := os.Open(s.seenJournal())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer in.Close()
	cutoff := time.Now().Add(-7 * 24 * time.Hour).Unix()
	tmp := s.seenJournal() + ".tmp"
	out, err := os.OpenFile(tmp, os.O_TRUNC|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 4<<10), 16<<10)
	for sc.Scan() {
		parts := strings.SplitN(sc.Text(), "\t", 2)
		if len(parts) == 2 {
			if ts, _ := strconv.ParseInt(parts[0], 10, 64); ts < cutoff {
				continue
			}
		}
		fmt.Fprintln(out, sc.Text())
	}
	out.Close()
	return os.Rename(tmp, s.seenJournal())
}

func writeJSONAtomic(path string, v any, perm os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
