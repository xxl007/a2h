// Deployment adapter: the worker's file storage and file events on AWS (S3 and
// the stage's SQS queue, ADR 0005 item 4). Credentials come from the task role.
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { FilesConfig } from "../src/config.ts";
import type { Log } from "../src/log.ts";
import type { WorkerFiles } from "../src/worker.ts";
import { SqsFileEvents, sqsQueueClient } from "./file-events.ts";
import { S3FileStore } from "./s3-store.ts";

export function deployedFiles(config: FilesConfig, log: Log): WorkerFiles {
  return {
    store: new S3FileStore(new S3Client({}), config.bucket),
    events: new SqsFileEvents(sqsQueueClient(new SQSClient({}), config.queueUrl), { bucket: config.bucket, storagePrefix: config.storagePrefix }, log),
    storagePrefix: config.storagePrefix,
  };
}
