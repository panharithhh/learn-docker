import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MetricsService } from './metrics.service';
import { ObservabilityController } from './observability.controller';
import { RedisHealthIndicator } from './redis.health';

@Global()
@Module({
  imports: [TerminusModule],
  controllers: [ObservabilityController],
  providers: [MetricsService, RedisHealthIndicator],
  exports: [MetricsService],
})
export class ObservabilityModule {}
