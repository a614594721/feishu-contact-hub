# 多阶段构建：静态二进制 + scratch 基镜像（无 shell、无依赖、攻击面最小）
# 时区数据库由 Go 内嵌（time/tzdata），CA 证书从 builder 拷贝
FROM golang:1.21-alpine AS builder
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/lark-watcher ./cmd/watcher

FROM scratch
COPY --from=builder /out/lark-watcher /lark-watcher
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ENV TZ=Asia/Shanghai \
    DATA_DIR=/data \
    WATCH_INTERVAL=5s \
    WATCH_OVERLAP=90s \
    WATCH_CONCURRENCY=6 \
    OUTPUT_FILE=/data/msgs.jsonl

VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/lark-watcher", "-mode", "status"]
ENTRYPOINT ["/lark-watcher"]
