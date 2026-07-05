CREATE TABLE `daily_metrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`date` varchar(10) NOT NULL,
	`tasksGenerated` int NOT NULL DEFAULT 0,
	`tasksCompleted` int NOT NULL DEFAULT 0,
	`tasksFailed` int NOT NULL DEFAULT 0,
	`callsMade` int NOT NULL DEFAULT 0,
	`emailsSent` int NOT NULL DEFAULT 0,
	`smsSent` int NOT NULL DEFAULT 0,
	`apiSpendCents` int NOT NULL DEFAULT 0,
	`successRate` decimal(5,4),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `daily_metrics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`taskId` int,
	`success` enum('true','false','partial') NOT NULL,
	`conversionRate` decimal(5,4),
	`costTokens` int,
	`lessonLearned` text,
	`strategyUsed` varchar(128),
	`improvementSuggestion` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `evaluations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`taskId` int,
	`actionType` varchar(64) NOT NULL,
	`details` json,
	`outcome` enum('success','failure','partial','pending') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`durationMs` int,
	`tokensCost` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`goalText` text NOT NULL,
	`status` enum('active','paused','completed','archived') NOT NULL DEFAULT 'active',
	`subGoals` json,
	`priority` int NOT NULL DEFAULT 5,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `goals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` varchar(128) NOT NULL,
	`description` text NOT NULL,
	`priority` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`status` enum('new','investigating','actioned','dismissed') NOT NULL DEFAULT 'new',
	`estimatedValue` decimal(10,2),
	`metadata` json,
	`detectedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `opportunities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configKey` varchar(128) NOT NULL,
	`configValue` text NOT NULL,
	`description` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `system_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `system_config_configKey_unique` UNIQUE(`configKey`)
);
--> statement-breakpoint
CREATE TABLE `task_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`goalId` int,
	`source` varchar(64) NOT NULL DEFAULT 'task_generator',
	`description` text NOT NULL,
	`priorityScore` int NOT NULL DEFAULT 50,
	`status` enum('pending','in_progress','completed','failed','cancelled','awaiting_approval') NOT NULL DEFAULT 'pending',
	`assignedAgent` varchar(64) DEFAULT 'autonomous_worker',
	`actionType` varchar(64),
	`actionPayload` json,
	`resultSummary` text,
	`metadata` json,
	`estimatedValue` decimal(10,2),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `task_queue_id` PRIMARY KEY(`id`)
);
