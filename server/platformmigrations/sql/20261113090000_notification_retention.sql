-- The notification-retention maintenance job deletes notifications and their
-- delivery records 90 days after creation, a batch at a time. These indexes let
-- each batch read only expired rows instead of scanning the table again.
CREATE INDEX platform_notification_inbox_retention ON platform_notification_inbox (created_at);
CREATE INDEX platform_notification_delivery_retention ON platform_notification_delivery (created_at);
