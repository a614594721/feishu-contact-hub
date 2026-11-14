// Package sdnotify 实现 systemd notify 协议（零依赖）。
// 容器场景：宿主 systemd unit 为 Type=notify，运行容器时挂载
//
//	-v /run/systemd/notify:/run/systemd/notify
//
// 容器内进程向 NOTIFY_SOCKET 发送 READY=1 / WATCHDOG=1。
// 无 NOTIFY_SOCKET（本地直跑）时所有方法均为 no-op，不影响运行。
package sdnotify

import (
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Notifier struct {
	socket string
	// watchdog 喂狗间隔（0 = 未启用）
	interval time.Duration
	stop     chan struct{}
}

func New() *Notifier { return &Notifier{stop: make(chan struct{})} }

// Ready 发送 READY=1 并启动 watchdog 喂狗协程。
func (n *Notifier) Ready() {
	n.socket = os.Getenv("NOTIFY_SOCKET")
	if n.socket == "" {
		return // 非 systemd 环境，跳过
	}
	n.send("READY=1\nSTATUS=watching p2p messages")
	// watchdog 间隔 = WATCHDOG_USEC / 2（systemd 惯例取半）
	if us := os.Getenv("WATCHDOG_USEC"); us != "" {
		if v, err := strconv.ParseInt(us, 10, 64); err == nil && v > 0 {
			n.interval = time.Duration(v) * time.Microsecond / 2
			go n.loop()
		}
	}
}

// Stopping 优雅退出前通知 systemd。
func (n *Notifier) Stopping() {
	if n.socket == "" {
		return
	}
	n.send("STOPPING=1\nSTATUS=flushing state")
	close(n.stop)
}

func (n *Notifier) loop() {
	t := time.NewTicker(n.interval)
	defer t.Stop()
	for {
		select {
		case <-n.stop:
			return
		case <-t.C:
			n.send("WATCHDOG=1")
		}
	}
}

func (n *Notifier) send(state string) {
	socket := n.socket
	if strings.HasPrefix(socket, "@") { // systemd abstract socket
		socket = "\x00" + socket[1:]
	}
	c, err := net.DialTimeout("unixgram", socket, 2*time.Second)
	if err != nil {
		return // 静默失败：notify 不应影响主流程
	}
	defer c.Close()
	_, _ = c.Write([]byte(state))
}
