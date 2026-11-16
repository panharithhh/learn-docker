import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';

/**
 * Terminus has no Redis check, so this pings the Redis that BullMQ uses.
 * One small client, kept for the life of the app; it never queues commands
 * while disconnected, so a down Redis answers "down" at once instead of hanging.
 */
@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    config: ConfigService,
    private readonly health: HealthIndicatorService,
  ) {
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST'),
      port: Number(config.get('REDIS_PORT') ?? 6379),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
    });
    // Errors are reported by the check below; don't crash or spam the log
    this.client.on('error', () => undefined);
  }

  async pingCheck(key: string, timeoutMs = 1000) {
    const indicator = this.health.check(key);
    try {
      if (this.client.status === 'wait' || this.client.status === 'end')
        await this.client.connect();
      const reply = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timeout after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      return reply === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `unexpected reply ${String(reply)}` });
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
