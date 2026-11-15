/*
飞书通讯录同步与消息订阅管理台：MSSQL 业务表初始化

要求：SQL Server 2016+，目标数据库兼容级别 >= 130。
用法：在 SSMS 中先选择已创建的业务数据库，再执行整个文件。
范围：创建 7 张 dbo 业务表、业务唯一约束和查询索引；不创建数据库或账号。
重复执行：存在的表整体跳过，不删除数据，也不升级既有表结构。
时间约定：DATETIME2(3) 字段均存 UTC；ts_ms 存 Unix 毫秒。
JSON 约定：department_ids 为字符串数组，raw 为序列化的事件对象。

注意：当前 server.mjs 使用 Supabase / 本地 JSON，尚未实现 MSSQL 驱动。
      本脚本准备表结构，应用直连 MSSQL 仍需数据访问层适配。
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;

IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb')
BEGIN
    ;THROW 50001, N'请先选择业务数据库，不允许在系统数据库创建这些表。', 1;
END;

IF CONVERT(INT, SERVERPROPERTY('ProductMajorVersion')) < 13
BEGIN
    ;THROW 50002, N'此脚本需要 SQL Server 2016 或更高版本。', 1;
END;

IF (SELECT compatibility_level FROM sys.databases WHERE database_id = DB_ID()) < 130
BEGIN
    ;THROW 50003, N'目标数据库兼容级别必须至少为 130；请由管理员确认后调整。', 1;
END;

BEGIN TRY
    BEGIN TRANSACTION;

    -- 配置值包括 app_id/app_secret/encrypt_key/verification_token/last_sync_at。
    IF OBJECT_ID(N'dbo.app_config', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.app_config (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_app_config PRIMARY KEY,
            [key] NVARCHAR(128) COLLATE Latin1_General_100_BIN2 NOT NULL,
            [value] NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_app_config_value DEFAULT (N''),
            updated_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_app_config_updated_at DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT UQ_app_config_key UNIQUE ([key])
        );
    END;

    IF OBJECT_ID(N'dbo.feishu_departments', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.feishu_departments (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_feishu_departments PRIMARY KEY,
            department_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            [name] NVARCHAR(500) NOT NULL
                CONSTRAINT DF_feishu_departments_name DEFAULT (N''),
            parent_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_feishu_departments_parent DEFAULT (N''),
            member_count INT NOT NULL
                CONSTRAINT DF_feishu_departments_count DEFAULT (0),
            synced_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_feishu_departments_synced_at DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT UQ_feishu_departments_department_id UNIQUE (department_id),
            CONSTRAINT CK_feishu_departments_count CHECK (member_count >= 0)
        );
        CREATE INDEX IX_feishu_departments_parent_id
            ON dbo.feishu_departments (parent_id);
    END;

    IF OBJECT_ID(N'dbo.feishu_users', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.feishu_users (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_feishu_users PRIMARY KEY,
            open_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            user_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_feishu_users_user_id DEFAULT (N''),
            [name] NVARCHAR(500) NOT NULL
                CONSTRAINT DF_feishu_users_name DEFAULT (N''),
            email NVARCHAR(512) NOT NULL
                CONSTRAINT DF_feishu_users_email DEFAULT (N''),
            mobile NVARCHAR(64) NOT NULL
                CONSTRAINT DF_feishu_users_mobile DEFAULT (N''),
            avatar NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_feishu_users_avatar DEFAULT (N''),
            job_title NVARCHAR(500) NOT NULL
                CONSTRAINT DF_feishu_users_job_title DEFAULT (N''),
            department_ids NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_feishu_users_departments DEFAULT (N'[]'),
            active BIT NOT NULL
                CONSTRAINT DF_feishu_users_active DEFAULT (1),
            synced_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_feishu_users_synced_at DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT UQ_feishu_users_open_id UNIQUE (open_id),
            CONSTRAINT CK_feishu_users_departments_json CHECK (
                ISJSON(department_ids) = 1
                AND LEFT(LTRIM(department_ids), 1) = N'['
                AND RIGHT(RTRIM(department_ids), 1) = N']'
            )
        );
        -- 名称排序匹配当前人员列表。%关键词% 搜索仍可能需要扫描。
        CREATE INDEX IX_feishu_users_name ON dbo.feishu_users ([name]);
    END;

    IF OBJECT_ID(N'dbo.feishu_events', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.feishu_events (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_feishu_events PRIMARY KEY,
            event_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            event_type NVARCHAR(128) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_feishu_events_type DEFAULT (N'im.message.receive_v1'),
            chat_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_feishu_events_chat_id DEFAULT (N''),
            chat_type NVARCHAR(32) NOT NULL
                CONSTRAINT DF_feishu_events_chat_type DEFAULT (N''),
            sender_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_feishu_events_sender_id DEFAULT (N''),
            sender_name NVARCHAR(500) NOT NULL
                CONSTRAINT DF_feishu_events_sender_name DEFAULT (N''),
            message_type NVARCHAR(64) NOT NULL
                CONSTRAINT DF_feishu_events_message_type DEFAULT (N''),
            content NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_feishu_events_content DEFAULT (N''),
            content_text NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_feishu_events_content_text DEFAULT (N''),
            event_time DATETIME2(3) NULL,
            received_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_feishu_events_received_at DEFAULT (SYSUTCDATETIME()),
            raw NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_feishu_events_raw DEFAULT (N'{}'),
            CONSTRAINT UQ_feishu_events_event_id UNIQUE (event_id),
            CONSTRAINT CK_feishu_events_raw_json CHECK (ISJSON(raw) = 1)
        );
        CREATE INDEX IX_feishu_events_time
            ON dbo.feishu_events (event_time DESC, id DESC);
        CREATE INDEX IX_feishu_events_type_time
            ON dbo.feishu_events (event_type, event_time DESC, id DESC);
        CREATE INDEX IX_feishu_events_chat_time
            ON dbo.feishu_events (chat_id, event_time DESC, id DESC);
    END;

    -- 保存 CLI 配置/授权流程标记，不是 user_access_token 存储表。
    -- CLI 自身管理其配置、登录态和 Token。
    IF OBJECT_ID(N'dbo.private_auth', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.private_auth (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_private_auth PRIMARY KEY,
            [key] NVARCHAR(128) COLLATE Latin1_General_100_BIN2 NOT NULL,
            [value] NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_private_auth_value DEFAULT (N''),
            updated_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_private_auth_updated_at DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT UQ_private_auth_key UNIQUE ([key])
        );
    END;

    IF OBJECT_ID(N'dbo.private_chats', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.private_chats (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_private_chats PRIMARY KEY,
            chat_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            [name] NVARCHAR(500) NOT NULL
                CONSTRAINT DF_private_chats_name DEFAULT (N''),
            peer_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_private_chats_peer_id DEFAULT (N''),
            chat_mode NVARCHAR(32) NOT NULL
                CONSTRAINT DF_private_chats_mode DEFAULT (N'p2p'),
            owner_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_private_chats_owner_id DEFAULT (N''),
            [external] BIT NOT NULL
                CONSTRAINT DF_private_chats_external DEFAULT (0),
            synced_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_private_chats_synced_at DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT UQ_private_chats_chat_id UNIQUE (chat_id)
        );
    END;

    IF OBJECT_ID(N'dbo.private_messages', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.private_messages (
            id BIGINT IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_private_messages PRIMARY KEY,
            message_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            chat_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL,
            sender_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_private_messages_sender_id DEFAULT (N''),
            sender_name NVARCHAR(500) NOT NULL
                CONSTRAINT DF_private_messages_sender_name DEFAULT (N''),
            msg_type NVARCHAR(64) NOT NULL
                CONSTRAINT DF_private_messages_type DEFAULT (N''),
            content_text NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_private_messages_content DEFAULT (N''),
            create_time DATETIME2(3) NOT NULL,
            ts_ms BIGINT NOT NULL,
            deleted BIT NOT NULL
                CONSTRAINT DF_private_messages_deleted DEFAULT (0),
            updated BIT NOT NULL
                CONSTRAINT DF_private_messages_updated DEFAULT (0),
            thread_id NVARCHAR(256) COLLATE Latin1_General_100_BIN2 NOT NULL
                CONSTRAINT DF_private_messages_thread_id DEFAULT (N''),
            synced_at DATETIME2(3) NOT NULL
                CONSTRAINT DF_private_messages_synced_at DEFAULT (SYSUTCDATETIME()),
            raw NVARCHAR(MAX) NOT NULL
                CONSTRAINT DF_private_messages_raw DEFAULT (N'{}'),
            CONSTRAINT UQ_private_messages_message_id UNIQUE (message_id),
            CONSTRAINT CK_private_messages_ts_ms CHECK (ts_ms >= 0),
            CONSTRAINT CK_private_messages_raw_json CHECK (ISJSON(raw) = 1)
        );
        CREATE INDEX IX_private_messages_chat_time
            ON dbo.private_messages (chat_id, ts_ms DESC, id DESC);
        CREATE INDEX IX_private_messages_time
            ON dbo.private_messages (ts_ms DESC, id DESC);
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;
    THROW;
END CATCH;

SELECT SCHEMA_NAME(schema_id) AS schema_name, [name] AS table_name
FROM sys.tables
WHERE schema_id = SCHEMA_ID(N'dbo')
  AND [name] IN (
      N'app_config', N'feishu_departments', N'feishu_users', N'feishu_events',
      N'private_auth', N'private_chats', N'private_messages'
  )
ORDER BY [name];
