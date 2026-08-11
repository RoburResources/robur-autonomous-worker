CREATE TABLE `provider_webhook_inbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider` varchar(32) NOT NULL,
	`eventKey` varchar(128) NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`externalId` varchar(200) NOT NULL,
	`payloadDigest` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`state` enum('pending','processing','completed','terminal_failure') NOT NULL DEFAULT 'pending',
	`attemptCount` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(36),
	`leaseUntil` timestamp,
	`nextAttemptAt` timestamp,
	`workProduct` json,
	`lastError` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	`failedAt` timestamp,
	CONSTRAINT `provider_webhook_inbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_webhook_event_unique` UNIQUE(`provider`,`eventKey`)
);
--> statement-breakpoint
CREATE INDEX `provider_webhook_state_retry_idx` ON `provider_webhook_inbox` (`provider`,`state`,`nextAttemptAt`,`receivedAt`);--> statement-breakpoint
CREATE INDEX `provider_webhook_external_idx` ON `provider_webhook_inbox` (`provider`,`externalId`,`eventType`);