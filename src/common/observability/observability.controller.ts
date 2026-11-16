import {
  Controller,
  Get,
  Header,
  ParseIntPipe,
  Query,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { RoleName } from '../constants';
import { Public } from '../../auth/decorators/public.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { appLogger } from './app-logger';
import { MetricsService } from './metrics.service';
import { RedisHealthIndicator } from './redis.health';

@ApiTags('observability')
// Unversioned and outside /api: /health, /metrics, /observability/*
@Controller({ version: VERSION_NEUTRAL })
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly healthChecks: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Prometheus scrape target. */
  @Public()
  @ApiExcludeEndpoint()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  prometheus() {
    return this.metrics.registry.metrics();
  }

  /**
   * Liveness for Docker's HEALTHCHECK, Render and load balancers (Terminus).
   * 200 when every check is up; 503 with the failing check named when one is down.
   */
  @Public()
  @Get('health')
  @HealthCheck()
  health() {
    return this.healthChecks.check([
      () => this.db.pingCheck('database', { timeout: 1500 }),
      () => this.redis.pingCheck('redis'),
      // Flags a memory leak before the container runs out: heap above 512 MB
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  @Roles(RoleName.ADMIN)
  @Get('observability/metrics')
  metricsSummary() {
    return this.metrics.summary();
  }

  @Roles(RoleName.ADMIN)
  @Get('observability/logs')
  logs(
    @Query('level') level?: string,
    @Query('traceId') traceId?: string,
    @Query('context') context?: string,
    @Query('search') search?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return appLogger.query({ level, traceId, context, search, limit });
  }
}
