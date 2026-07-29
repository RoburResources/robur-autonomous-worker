CREATE INDEX `execution_outcome_created_task_idx` ON `execution_log` (`outcome`,`createdAt`,`taskId`);--> statement-breakpoint
CREATE INDEX `task_source_created_idx` ON `task_queue` (`source`,`createdAt`);--> statement-breakpoint
CREATE INDEX `task_status_completed_idx` ON `task_queue` (`status`,`completedAt`);