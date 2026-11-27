import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

/**
 * The background worker: the same application WITHOUT the HTTP server, running the jobs (outbox relay, reservation
 * sweeper, payment/refund reconciliation) and the event consumers. In production the API tasks run with
 * BACKGROUND_JOBS_ENABLED=false and one or more worker tasks run this entrypoint (`node dist/worker.js`); the jobs are
 * safe to run on several workers at once (SKIP LOCKED / conditional updates / de-duplicated consumers).
 */
process.env['BACKGROUND_JOBS_ENABLED'] = 'true'; // before the configuration is read

const { AppModule } = await import('./app.module.js');
const app = await NestFactory.createApplicationContext(AppModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks(); // SIGTERM from ECS: stop the timers, close the broker and database cleanly
app.get(Logger).log('Worker started (background jobs and consumers, no HTTP)');
